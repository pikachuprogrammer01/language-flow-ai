<script setup lang="ts">
// Language Flow AI — 入口组件（全局导航栏 + Toast）
import { useRoute } from "vue-router";
import { Toaster } from "vue-sonner";
import Button from "./components/ui/button.vue";

const route = useRoute();

/** 导航项：路径前缀匹配即激活（详情页也高亮记录入口） */
function isActive(path: string): boolean {
  return path === "/" ? route.path === "/" : route.path.startsWith(path);
}
</script>

<template>
  <div class="min-h-screen bg-gray-50 text-gray-900">
    <Toaster position="top-center" rich-colors />
    <nav class="border-b bg-white">
      <div class="mx-auto flex max-w-5xl items-center gap-2 px-6 py-3">
        <span class="mr-2 text-lg font-bold">Language Flow AI</span>
        <Button as-child :variant="isActive('/') ? 'secondary' : 'ghost'" size="sm">
          <RouterLink to="/">新建视频</RouterLink>
        </Button>
        <Button as-child :variant="isActive('/tasks') ? 'secondary' : 'ghost'" size="sm">
          <RouterLink to="/tasks">生成记录</RouterLink>
        </Button>
        <Button as-child :variant="isActive('/files') ? 'secondary' : 'ghost'" size="sm">
          <RouterLink to="/files">文件管理</RouterLink>
        </Button>
        <Button as-child :variant="isActive('/audit') ? 'secondary' : 'ghost'" size="sm">
          <RouterLink to="/audit">审计管理</RouterLink>
        </Button>
      </div>
    </nav>
    <router-view />
  </div>
</template>
