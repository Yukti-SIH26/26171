/**
 * Minimal structural types for the parts of WebGPU we touch.
 *
 * Declared locally rather than pulling in `@webgpu/types` because we only need
 * adapter discovery and limit reading, and an extra ambient-types dependency
 * would leak `GPUDevice` and friends into every file in the project.
 */

export interface GpuAdapterInfoLike {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly device?: string;
  readonly description?: string;
}

export interface GpuSupportedLimitsLike {
  readonly maxBufferSize?: number;
  readonly maxStorageBufferBindingSize?: number;
  readonly maxComputeWorkgroupStorageSize?: number;
  readonly maxComputeInvocationsPerWorkgroup?: number;
}

export interface GpuAdapterLike {
  readonly info?: GpuAdapterInfoLike;
  readonly limits?: GpuSupportedLimitsLike;
  requestAdapterInfo?: () => Promise<GpuAdapterInfoLike>;
}

export interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

export interface NavigatorWithGpu extends Navigator {
  readonly gpu?: GpuLike;
  /** Device Memory API. Chrome-only, coarse, in GiB. */
  readonly deviceMemory?: number;
}

export function navigatorWithGpu(): NavigatorWithGpu {
  return navigator as NavigatorWithGpu;
}
