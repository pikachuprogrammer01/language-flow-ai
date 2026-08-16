/**
 * 帧时长分配纯函数测试（docs/10 §八）
 * 覆盖：字符占比分配 / 末段吸收舍入误差 / 单元素 / 空数组 / 全零权重均分 / 末段过短补足
 */
import { describe, expect, it } from "vitest";
import { allocateDurations } from "./allocate-durations";

describe("allocateDurations", () => {
  it("按字符占比分配，总和等于总时长", () => {
    const durations = allocateDurations([10, 30, 60], 10);
    // 1s / 3s / 6s
    expect(durations).toEqual([1, 3, 6]);
    expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(10);
  });

  it("末段吸收四舍五入误差，总和精确等于总时长", () => {
    const durations = allocateDurations([3, 3, 3], 10);
    const sum = durations.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(10);
    // 前两段四舍五入到 0.1s，末段补足
    expect(durations[2]).toBeCloseTo(10 - durations[0] - durations[1], 5);
  });

  it("单元素：整段时长归该帧", () => {
    expect(allocateDurations([100], 8.5)).toEqual([8.5]);
  });

  it("空数组返回空列表", () => {
    expect(allocateDurations([], 10)).toEqual([]);
  });

  it("全零权重：均分总时长", () => {
    const durations = allocateDurations([0, 0, 0, 0], 8);
    const sum = durations.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(8);
    for (const d of durations) {
      expect(d).toBeGreaterThan(0);
    }
  });

  it("末段过短（<0.3s）时从前面匀出时长，保证每帧可读", () => {
    // 权重差极大：首段占 99% → 末段 <0.3s，应被补足
    const durations = allocateDurations([99, 1], 10);
    expect(durations[1]).toBeGreaterThanOrEqual(0.3);
    expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(10);
  });

  it("总时长过短无法满足每帧下限时，全部压到下限（FFmpeg -shortest 兜底）", () => {
    const durations = allocateDurations([1, 1, 1, 1, 1], 1);
    for (const d of durations) {
      expect(d).toBeGreaterThanOrEqual(0.3);
    }
  });
});
