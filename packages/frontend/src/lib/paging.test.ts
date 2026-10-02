import { describe, expect, it, vi } from "vitest";
import { fetchAllPages } from "./paging";

/** 造一个按 total 分页的数据源（末页为余数），记录被请求过的页码 */
function source(total: number, pageSize: number) {
  const pages = new Map<number, string[]>();
  let remaining = total;
  let page = 1;
  while (remaining > 0) {
    const size = Math.min(pageSize, remaining);
    pages.set(
      page,
      Array.from({ length: size }, (_, j) => `p${page}-${j}`),
    );
    remaining -= size;
    page += 1;
  }
  const requested: number[] = [];
  const loadPage = vi.fn(async (requestedPage: number) => {
    requested.push(requestedPage);
    return { rows: pages.get(requestedPage) ?? [], total };
  });
  return { loadPage, requested };
}

describe("fetchAllPages", () => {
  it("单页装得下时只请求一次", async () => {
    const { loadPage, requested } = source(44, 100);
    const result = await fetchAllPages(loadPage, 100);
    expect(result.rows).toHaveLength(44);
    expect(result.total).toBe(44);
    expect(requested).toEqual([1]);
  });

  it("超过单页容量时继续翻页，第 101 条起不再消失", async () => {
    const { loadPage, requested } = source(230, 100);
    const result = await fetchAllPages(loadPage, 100);
    expect(result.rows).toHaveLength(230);
    expect(requested).toEqual([1, 2, 3]);
  });

  it("total 大于实际可取行数时靠空页收敛，不死循环", async () => {
    // total 声称 300，但第 2 页起就是空页（并发删除场景）
    const loadPage = vi.fn(async (page: number) => ({
      rows: page === 1 ? new Array<string>(100).fill("x") : [],
      total: 300,
    }));
    const result = await fetchAllPages(loadPage, 100);
    expect(result.rows).toHaveLength(100);
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("返回 total 供 KPI 使用，而不是已加载条数", async () => {
    const { loadPage } = source(44, 100);
    await expect(fetchAllPages(loadPage, 100)).resolves.toMatchObject({ total: 44 });
  });
});
