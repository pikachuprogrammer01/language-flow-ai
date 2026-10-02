/**
 * 逐页装载工具 — 把「服务端有 total、客户端需要全量」的翻页循环从 API 胶水层里提出来，
 * 让终止条件可测（API 层在 vitest 覆盖率排除面内，循环失控不会在那里暴露）。
 */

export type Page<T> = { rows: T[]; total: number };

/**
 * 一直取到覆盖服务端 total 为止。
 * 空页立即收敛：并发删除会让 total 大于实际可取行数，拿 total 当唯一终点会死循环。
 */
export async function fetchAllPages<T>(
  loadPage: (page: number, pageSize: number) => Promise<Page<T>>,
  pageSize: number,
): Promise<Page<T>> {
  const first = await loadPage(1, pageSize);
  const rows = [...first.rows];
  let page = 2;
  while (rows.length < first.total) {
    const next = await loadPage(page, pageSize);
    if (next.rows.length === 0) break;
    rows.push(...next.rows);
    page += 1;
  }
  return { rows, total: first.total };
}
