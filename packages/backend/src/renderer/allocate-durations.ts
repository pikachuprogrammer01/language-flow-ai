/**
 * 帧时长分配纯函数
 * 依据：docs/10_视频渲染设计文档.md §五「帧时长分配（关键设计）」
 * - 总时长 = audio.duration（以 TTS 实际时长为准，保证声画同步）
 * - 按每个单元字符数占比 × 总时长
 * - 最后一段 = 总时长 − 前段之和（吸收舍入误差，保证总长精确）
 */

/** 每帧最短停留时长（秒），防止权重极小的单元出现 <0.1s 闪烁帧 */
export const MIN_FRAME_DURATION = 0.3;

/**
 * 将总时长按各单元字符数权重分配到每一帧
 * @param weights 每个单元的字符数（>0），长度即帧数
 * @param totalDuration 音频总时长（秒，>0）
 * @returns 每帧停留时长（秒），总和 = totalDuration（四舍五入到 0.1s，末段吸收误差）
 */
export function allocateDurations(weights: number[], totalDuration: number): number[] {
  if (weights.length === 0) {
    return [];
  }
  const totalWeight = weights.reduce((sum, w) => sum + Math.max(w, 0), 0);
  if (totalWeight === 0) {
    // 全部权重为 0：均分（每帧至少 MIN_FRAME_DURATION，超出部分按序补足）
    return evenlySplit(weights.length, totalDuration);
  }

  const raw = weights.map((w) => (Math.max(w, 0) / totalWeight) * totalDuration);
  const rounded = raw.slice(0, -1).map((d) => Math.round(d * 10) / 10);
  const last = totalDuration - rounded.reduce((sum, d) => sum + d, 0);

  // 末段过短（< MIN_FRAME_DURATION）时从前面匀出时长，保证每帧可读
  const result = [...rounded, Math.round(last * 10) / 10];
  if (result[result.length - 1] < MIN_FRAME_DURATION) {
    const deficit = MIN_FRAME_DURATION - result[result.length - 1];
    for (let i = 0; i < result.length - 1 && deficit > 0.001; i++) {
      const take = Math.min(result[i] - MIN_FRAME_DURATION, deficit);
      if (take > 0) {
        result[i] = Math.round((result[i] - take) * 10) / 10;
        result[result.length - 1] = Math.round((result[result.length - 1] + take) * 10) / 10;
        break;
      }
    }
  }
  // 匀完后仍有帧低于下限（总时长不足以满足每帧下限）：全部压到下限（FFmpeg -shortest 兜底）
  if (result.some((d) => d < MIN_FRAME_DURATION)) {
    return new Array(weights.length).fill(MIN_FRAME_DURATION);
  }
  return result;
}

/** 均分时长（每帧至少 MIN_FRAME_DURATION） */
function evenlySplit(frameCount: number, totalDuration: number): number[] {
  const per = totalDuration / frameCount;
  if (per >= MIN_FRAME_DURATION) {
    const rounded = new Array(frameCount - 1).fill(Math.round(per * 10) / 10);
    const last = totalDuration - rounded.reduce((s, d) => s + d, 0);
    return [...rounded, Math.round(last * 10) / 10];
  }
  // 总时长不足以让每帧达标：全部压到 MIN_FRAME_DURATION，总长略超（FFmpeg -shortest 兜底）
  return new Array(frameCount).fill(MIN_FRAME_DURATION);
}
