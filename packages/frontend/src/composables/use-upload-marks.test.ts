/**
 * 上传标记索引单测 — 双索引构建 / 任务优先回退文件名 / 加载失败静默不阻塞列表
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { useUploadMarks } from "../composables/use-upload-marks";

vi.mock("../api/client", () => ({ listUploadMarks: vi.fn() }));

const mark = (over: Partial<api.UploadMark>): api.UploadMark => ({
  id: "m1",
  taskId: null,
  videoFilename: "v1.mp4",
  platform: "抖音",
  url: null,
  note: null,
  createdAt: "",
  updatedAt: "",
  ...over,
});

beforeEach(() => {
  vi.mocked(api.listUploadMarks).mockReset();
});

describe("useUploadMarks", () => {
  it("按文件名与 taskId 双维度建索引", async () => {
    vi.mocked(api.listUploadMarks).mockResolvedValue([
      mark({ id: "a", taskId: "t1", videoFilename: "v1.mp4" }),
      mark({ id: "b", taskId: "t1", videoFilename: "v1.mp4", platform: "B站" }),
      mark({ id: "c", taskId: null, videoFilename: "v2.mp4" }),
    ]);
    const { loadMarks, marksOf, marksOfTask } = useUploadMarks();
    await loadMarks();
    expect(marksOf("v1.mp4")).toHaveLength(2);
    expect(marksOfTask({ id: "t1", video: { url: "/files/video/renamed.mp4" } })).toHaveLength(2);
  });

  it("任务无 taskId 关联时回退文件名匹配（兼容历史标记）", async () => {
    vi.mocked(api.listUploadMarks).mockResolvedValue([mark({ id: "x", taskId: null })]);
    const { loadMarks, marksOfTask } = useUploadMarks();
    await loadMarks();
    expect(marksOfTask({ id: "t9", video: { url: "/files/video/v1.mp4" } })).toHaveLength(1);
    expect(marksOfTask({ id: "t8", video: null })).toHaveLength(0);
  });

  it("拉取失败静默（不抛、索引保持空，列表页不被阻塞）", async () => {
    vi.mocked(api.listUploadMarks).mockRejectedValue(new Error("network down"));
    const { loadMarks, marksOf } = useUploadMarks();
    await expect(loadMarks()).resolves.toBeUndefined();
    expect(marksOf("v1.mp4")).toHaveLength(0);
  });
});
