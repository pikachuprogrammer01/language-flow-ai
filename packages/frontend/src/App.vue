<script setup lang="ts">
// LanguageFlow AI — 入口组件（深色侧边栏 + 顶栏布局，1:1 还原后台原型）
// 响应式：≥lg 常驻侧边栏（可折叠成只剩图标，状态入 localStorage）；小屏隐藏，顶栏汉堡按钮开合抽屉 + 遮罩关闭
import {
  Activity,
  ArrowLeft,
  FileDown,
  FolderOpen,
  History,
  LayoutDashboard,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  SquareCheck,
  TrendingUp,
  Upload,
} from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import LlmStatus from "./components/llm-status.vue";
import AppToaster from "./components/ui/app-toaster.vue";
import ConfirmDialog from "./components/ui/confirm-dialog.vue";
import { confirmAbandonCreate, goCreate, useCreateSession } from "./lib/create-session";
import { useSidebarCollapse } from "./lib/sidebar-collapse";
const route = useRoute();
const router = useRouter();

// ── 分析域返回（层级嵌套深：所有 /insights* 页面顶栏提供「← 返回」回上一界面） ──

const inInsights = computed(() => route.path.startsWith("/insights"));

function goBack(): void {
  const state = window.history.state as { back?: string | null } | null;
  if (state?.back) {
    router.back();
    return;
  }
  // 直达子页无历史：回分析首页；首页本身无历史回工作台
  router.push(route.path === "/insights" ? "/" : "/insights");
}
/** 创建会话：全站「新建视频」入口按 busy/done/idle 分流（放弃确认弹窗单实例挂本组件） */
const { abandonConfirmOpen } = useCreateSession();

/** 小屏导航抽屉开关 */
const drawerOpen = ref(false);
/** 侧边栏折叠（仅 lg 以上生效；图标态 + 悬停浮出名称 + localStorage 记住） */
const { collapsed, toggle } = useSidebarCollapse();
/** 路由变化（含抽屉内跳转）后自动收起抽屉 */
watch(
  () => route.fullPath,
  () => {
    drawerOpen.value = false;
  },
);

/** 侧边栏导航（原型三分组：生产中心 / 内容资产 / 运营与系统） */
const NAV_GROUPS: {
  label: string;
  items: { path: string; label: string; icon: typeof LayoutDashboard; exact?: boolean }[];
}[] = [
  {
    label: "生产中心",
    items: [
      { path: "/", label: "工作台", icon: LayoutDashboard, exact: true },
      { path: "/create", label: "新建视频", icon: Plus },
      { path: "/tasks", label: "生成记录", icon: History },
    ],
  },
  {
    label: "内容资产",
    items: [
      { path: "/videos", label: "视频资产", icon: Play },
      { path: "/analytics", label: "发布管理", icon: Upload },
      { path: "/files", label: "文件管理", icon: FolderOpen },
    ],
  },
  {
    label: "运营与系统",
    items: [
      { path: "/insights", label: "数据分析", icon: TrendingUp },
      { path: "/insights/import", label: "数据导入", icon: FileDown },
      { path: "/marks", label: "上传标记", icon: SquareCheck },
      { path: "/audit", label: "审计管理", icon: Activity },
    ],
  },
];

/** 侧边栏导航激活：工作台精确匹配，其余最长前缀匹配（数据导入不被数据分析吞并高亮） */
function isActive(item: { path: string; exact?: boolean }): boolean {
  if (item.exact) return route.path === "/";
  const all = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.path));
  const matched = all.filter((p) => route.path.startsWith(p));
  const longest = matched.sort((a, b) => b.length - a.length)[0];
  return longest === item.path;
}

/** 侧边栏点击：「新建视频」走创建会话分流（busy 确认放弃 / done 重新创建），其余正常导航 */
function onNavClick(event: MouseEvent, path: string): void {
  if (path === "/create") {
    event.preventDefault();
    goCreate();
  }
}

/** 顶栏面包屑：跟随路由 meta.title */
const crumb = computed(() => String(route.meta.title ?? "工作台"));
</script>

<template>
  <div class="flex min-h-screen bg-shell text-ink">
    <AppToaster />

    <!-- 小屏遮罩（仅抽屉打开时渲染） -->
    <div
      v-if="drawerOpen"
      class="fixed inset-0 z-40 bg-black/40 lg:hidden"
      @click="drawerOpen = false"
    />

    <!-- 侧边栏（原型 .sidebar：238px 深色；小屏变体：fixed 抽屉滑入滑出；lg 以上可折叠成 64px 图标栏） -->
    <aside
      class="group/sidebar fixed inset-y-0 left-0 z-50 flex h-screen w-[238px] shrink-0 flex-col bg-sidebar px-3.5 py-[18px] transition-all duration-200 lg:sticky lg:top-0 lg:translate-x-0"
      :class="[
        drawerOpen ? 'translate-x-0' : '-translate-x-full',
        collapsed ? 'lg:w-[64px] lg:px-2' : '',
      ]"
      :data-collapsed="collapsed ? 'true' : 'false'"
    >
      <RouterLink
        to="/"
        class="flex items-center gap-2.5 px-2.5 pb-[18px] pt-1.5 text-white"
        :class="collapsed ? 'lg:justify-center lg:gap-0 lg:px-0' : ''"
        :title="collapsed ? 'LanguageFlow AI' : undefined"
      >
        <!-- 品牌图标（public/languageflow_ai_logo_assets 官方 logo，透明底裁切版） -->
        <img
          src="/logo-icon.png"
          alt="LanguageFlow AI"
          width="32"
          height="32"
          class="h-8 w-8 shrink-0"
        />
        <span class="text-[17px] leading-tight font-extrabold lg:group-data-[collapsed=true]/sidebar:hidden"
          >LanguageFlow
          <span
            class="bg-gradient-to-r from-[#2b7bff] to-[#6a5cff] bg-clip-text text-transparent"
            >AI</span
          ></span
        >
      </RouterLink>
      <nav class="flex-1 overflow-y-auto">
        <div v-for="group in NAV_GROUPS" :key="group.label" class="mt-3.5">
          <p class="px-3 pb-2 text-[11px] text-sidebar-label uppercase lg:group-data-[collapsed=true]/sidebar:hidden">
            {{ group.label }}
          </p>
          <div
            class="mx-auto my-2 hidden h-px w-6 bg-white/10 lg:group-data-[collapsed=true]/sidebar:block"
            aria-hidden="true"
          />
          <div>
            <RouterLink
              v-for="item in group.items"
              :key="item.path"
              :to="item.path"
              class="my-[3px] flex items-center gap-[11px] rounded-[10px] px-3 py-2.5 text-sm no-underline transition-colors"
              :class="[
                collapsed ? 'lg:justify-center lg:gap-0 lg:px-0' : '',
                isActive(item)
                  ? 'bg-sidebar-item text-white shadow-[inset_3px_0_0_var(--color-brand-2)]'
                  : 'text-sidebar-text hover:bg-sidebar-item hover:text-white',
              ]"
              :aria-label="item.label"
              :title="item.label"
              @click="onNavClick($event, item.path)"
            >
              <component :is="item.icon" :size="16" class="shrink-0" />
              <span class="lg:group-data-[collapsed=true]/sidebar:hidden">{{ item.label }}</span>
            </RouterLink>
          </div>
        </div>
      </nav>
      <!-- 折叠开关：侧边栏自己的底部按钮条（44px 高整宽命中区，不压内容边界、不与 logo 打架）；仅 lg 以上 -->
      <button
        type="button"
        class="mt-2 hidden h-11 shrink-0 items-center gap-[11px] rounded-[10px] border-t border-white/10 px-3 pt-2.5 text-[13px] text-sidebar-text transition-colors hover:bg-sidebar-item hover:text-white lg:flex"
        :class="collapsed ? 'lg:justify-center lg:gap-0 lg:px-0' : ''"
        :aria-label="collapsed ? '展开侧边栏' : '收起侧边栏'"
        :aria-expanded="!collapsed"
        :title="collapsed ? '展开侧边栏' : undefined"
        data-testid="sidebar-toggle"
        @click="toggle"
      >
        <component
          :is="collapsed ? PanelLeftOpen : PanelLeftClose"
          :size="16"
          class="shrink-0"
          aria-hidden="true"
        />
        <span class="lg:group-data-[collapsed=true]/sidebar:hidden">收起侧边栏</span>
      </button>
    </aside>

    <!-- 主区（原型 .main：topbar + content） -->
    <main class="min-w-0 flex-1">
      <header
        class="sticky top-0 z-10 flex h-[68px] items-center justify-between border-b border-hairline bg-white/90 px-7 backdrop-blur-md"
      >
        <div class="flex min-w-0 items-center gap-3">
          <!-- 小屏导航按钮（侧边栏隐藏时唤起抽屉） -->
          <button
            class="cursor-pointer rounded-[10px] border border-hairline bg-white p-2 hover:bg-gray-50 lg:hidden"
            aria-label="打开导航菜单"
            :aria-expanded="drawerOpen"
            @click="drawerOpen = true"
          >
            <Menu :size="18" />
          </button>
          <button
            v-if="inInsights"
            class="flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-hairline bg-white px-2.5 py-1.5 text-sm text-subtle hover:bg-gray-50 hover:text-ink"
            data-testid="insights-back"
            @click="goBack"
          >
            <ArrowLeft class="h-4 w-4" aria-hidden="true" /> 返回
          </button>
          <p class="truncate font-bold">{{ crumb }}</p>
        </div>
        <div class="flex items-center gap-2.5">
          <!-- LLM 引擎状态位（探测/唤醒/轮询自含在组件内） -->
          <LlmStatus />
          <button
            class="flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-brand bg-brand px-3.5 py-[9px] text-sm text-white hover:opacity-90"
            @click="goCreate()"
          >
            <Plus class="h-4 w-4" aria-hidden="true" /> 新建视频
          </button>
        </div>
      </header>
      <router-view />
    </main>

    <!-- 新建视频入口的“放弃当前创建”二次确认（busy 时弹出；确认→中断+重置+进页） -->
    <ConfirmDialog
      v-model:open="abandonConfirmOpen"
      title="放弃当前创建？"
      description="正在创建视频，切换将中断本次生成（配音/渲染成果不保留）。放弃后回到全新创建表单。"
      confirm-text="放弃并新建"
      cancel-text="继续创建"
      destructive
      @confirm="confirmAbandonCreate"
    />
  </div>
</template>
