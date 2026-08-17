import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-vue 工具：合并 Tailwind 类 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
