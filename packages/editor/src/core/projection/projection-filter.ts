import type {
  Revision,
  TextRange,
} from "@jot-md/editor-protocol";

export interface SurfaceLayoutContext {
  readonly availableWidth: number;
  readonly lineHeight: number;
  readonly averageCharacterWidth: number;
  readonly tabSize: number;
  readonly widthBucketSize: number;
  readonly typographyVersion: string;
  readonly wrap: boolean;
}

export interface SurfaceItem {
  /** 稳定的 DOM 外壳身份；内容变化在原外壳上原地更新。 */
  readonly key: string;
  readonly kind: string;
  readonly sourceRange: TextRange;
  readonly contentVersion: number;
  /** 实测布局值使用的精确失效键。 */
  readonly layoutKey: string;
  readonly estimatedHeight: number;
}

export interface ProjectionFilterInput<T, TContext = undefined> {
  readonly revision: Revision;
  readonly viewRevision: number;
  readonly items: readonly T[];
  readonly layout: SurfaceLayoutContext;
  readonly context: TContext;
}

export interface ProjectionFilterResult<T extends SurfaceItem> {
  readonly revision: Revision;
  readonly viewRevision: number;
  readonly items: readonly T[];
}

/** projection filter 是同步的，不持有 Worker、DOM 或滚动状态。 */
export interface ProjectionFilter<TInput, TOutput extends SurfaceItem, TContext = undefined> {
  filter(input: ProjectionFilterInput<TInput, TContext>): ProjectionFilterResult<TOutput>;
}

export function surfaceLayoutContextKey(context: SurfaceLayoutContext): string {
  return [
    bucketWidth(context.availableWidth, context.widthBucketSize),
    context.lineHeight,
    context.averageCharacterWidth,
    context.tabSize,
    context.typographyVersion,
    context.wrap ? "wrap" : "nowrap",
  ].join(":");
}

export function bucketWidth(width: number, bucketSize: number): number {
  const boundedBucket = Number.isFinite(bucketSize) && bucketSize > 0 ? bucketSize : 32;
  const boundedWidth = Number.isFinite(width) && width > 0 ? width : boundedBucket;
  return Math.max(boundedBucket, Math.floor(boundedWidth / boundedBucket) * boundedBucket);
}
