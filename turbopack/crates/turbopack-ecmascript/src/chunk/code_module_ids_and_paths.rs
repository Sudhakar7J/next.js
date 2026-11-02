use anyhow::Result;
use bincode::{Decode, Encode};
use rustc_hash::FxHashMap;
use smallvec::{SmallVec, smallvec};
use turbo_rcstr::RcStr;
use turbo_tasks::{
    NonLocalValue, ReadRef, ResolvedVc, TryJoinIterExt, ValueToString, Vc, debug::ValueDebugFormat,
};
use turbo_tasks_fs::{OptionByteRange, rope::Rope};
use turbopack_core::{
    chunk::{AsyncModuleInfo, ChunkItem, ChunkItemExt, MangleType, MinifyType, ModuleId},
    code_builder::CodeCells,
};

use crate::{
    chunk::{
        EcmascriptChunkItem, EcmascriptChunkItemBatchGroup, EcmascriptChunkItemCode,
        EcmascriptChunkItemExt, EcmascriptChunkItemOrBatchWithAsyncInfo,
        EcmascriptChunkItemWithAsyncInfo, item::module_factory_code,
    },
    minify::minify_chunk_item,
};

async fn code_module_id_and_path(
    item: &EcmascriptChunkItemWithAsyncInfo,
    minify: MinifyType,
    source_maps: bool,
) -> Result<CodeModuleIdAndPath> {
    let async_info = item.async_info.map(|info| *info);
    // `MinifyType::NoMinify` here means the chunk will be minified as a whole later (or not at
    // all); only the per-item mode asks for the factory to be minified now. A strict factory keeps
    // its `"use strict"` directive either way; the chunk drops it where it places the factory in a
    // strict context (see `write_module_factories`).
    let factory = match minify {
        MinifyType::Minify { mangle } => {
            minified_module_factory(
                Vc::upcast_non_strict(*item.chunk_item),
                async_info,
                source_maps,
                MinifyType::Minify {
                    // `OptimalSize` orders mangled names by the character frequency of the code
                    // being minified. Per item, that order differs from factory to factory, which
                    // hurts gzip across the chunk. A fixed order keeps names consistent between
                    // factories.
                    mangle: mangle.map(|_| MangleType::Deterministic),
                },
            )
            .await?
        }
        MinifyType::NoMinify => item.chunk_item.code(async_info).await?,
    };
    let cells = factory.code;
    let cells_value = cells.await?;
    Ok(CodeModuleIdAndPath {
        id: item.chunk_item.id().await?,
        code: cells_value.code(),
        strict_directive: cells_value.strict_directive_range(),
        cells,
        path: item.chunk_item.asset_ident().to_string().owned().await?,
        strict: factory.strict,
    })
}

/// A chunk item's module factory, generated and minified on its own in this one task, and stored
/// as its own persisted cells so that chunks can reference the minified bytes instead of
/// persisting a copy (and so that a cache restore doesn't re-minify unchanged factories).
///
/// Only the minified factory is stored: the unminified one is an intermediate of this task.
/// Changing the minification options therefore generates the factories again, which is fine:
/// they rarely change.
#[turbo_tasks::function]
async fn minified_module_factory(
    chunk_item: Vc<Box<dyn EcmascriptChunkItem>>,
    async_module_info: Option<Vc<AsyncModuleInfo>>,
    source_maps: bool,
    minify: MinifyType,
) -> Result<Vc<EcmascriptChunkItemCode>> {
    let MinifyType::Minify { mangle } = minify else {
        anyhow::bail!("minified_module_factory called without minification");
    };
    let (code, strict) = module_factory_code(chunk_item, async_module_info).await?;
    let minified = minify_chunk_item(&code, source_maps, mangle)?;
    Ok(EcmascriptChunkItemCode {
        code: minified.resolved_code_cells(),
        strict,
    }
    .cell())
}

/// A chunk item's module factory, as referenced by a chunk. Holds only references to the
/// factory's cells, not its bytes, so it stays equal when only the factory's bytes change (and a
/// chunk's composition, which depends on it, isn't recomputed). Being references, ids and paths
/// only, it is cheap to persist.
#[derive(Clone, PartialEq, Eq, ValueDebugFormat, NonLocalValue, Encode, Decode)]
pub struct CodeModuleIdAndPath {
    pub id: ModuleId,
    /// The factory's persisted cells.
    pub cells: ResolvedVc<CodeCells>,
    /// The cell holding the factory's bytes ([`CodeCells::code`]).
    pub code: ResolvedVc<Rope>,
    /// The cell holding the byte range of the factory's strict directive
    /// ([`CodeCells::strict_directive_range`]).
    pub strict_directive: ResolvedVc<OptionByteRange>,
    pub path: RcStr,
    pub strict: bool,
}

/// Persisted: it only holds references, ids and paths (see [`CodeModuleIdAndPath`]).
#[turbo_tasks::value(transparent)]
pub struct CodeModuleIdsAndPaths(
    #[bincode(with = "turbo_bincode::smallvec")] SmallVec<[CodeModuleIdAndPath; 1]>,
);

/// Persisted: the values only hold references, ids and paths (see [`CodeModuleIdAndPath`]).
#[turbo_tasks::value(transparent)]
pub struct BatchGroupCodeModuleIdsAndPaths(
    FxHashMap<EcmascriptChunkItemOrBatchWithAsyncInfo, ReadRef<CodeModuleIdsAndPaths>>,
);

#[turbo_tasks::function]
pub async fn batch_group_code_module_ids_and_paths(
    batch_group: Vc<EcmascriptChunkItemBatchGroup>,
    minify: MinifyType,
    source_maps: bool,
) -> Result<Vc<BatchGroupCodeModuleIdsAndPaths>> {
    Ok(Vc::cell(
        batch_group
            .await?
            .items
            .iter()
            .map(async |item| {
                Ok((
                    item.clone(),
                    item_code_module_ids_and_paths(item.clone(), minify, source_maps).await?,
                ))
            })
            .try_join()
            .await?
            .into_iter()
            .collect(),
    ))
}

#[turbo_tasks::function]
pub async fn item_code_module_ids_and_paths(
    item: EcmascriptChunkItemOrBatchWithAsyncInfo,
    minify: MinifyType,
    source_maps: bool,
) -> Result<Vc<CodeModuleIdsAndPaths>> {
    Ok(Vc::cell(match item {
        EcmascriptChunkItemOrBatchWithAsyncInfo::ChunkItem(item) => {
            smallvec![code_module_id_and_path(&item, minify, source_maps).await?]
        }
        EcmascriptChunkItemOrBatchWithAsyncInfo::Batch(batch) => batch
            .await?
            .chunk_items
            .iter()
            .map(async |item| code_module_id_and_path(item, minify, source_maps).await)
            .try_join()
            .await?
            .into(),
    }))
}
