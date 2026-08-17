<script setup lang="ts">
// Language Flow AI — 入口组件（全局导航栏 + Toast）
import { Toaster } from "sonner";
</script>

<template>
  <div class="min-h-screen bg-gray-50 text-gray-900">
    <Toaster position="top-center" rich-colors />
    <nav class="border-b bg-white">
      <div class="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3">
        <span class="text-lg font-bold">Language Flow AI</span>
        <router-link
          to="/"
          class="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
          active-class="bg-blue-50 font-medium text-blue-700"
          exact-active-class="bg-blue-50 font-medium text-blue-700"
        >
          新建视频
        </router-link>
        <router-link
          to="/tasks"
          class="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
          active-class="bg-blue-50 font-medium text-blue-700"
        >
          生成记录
        </router-link>
        <router-link
          to="/files"
          class="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
          active-class="bg-blue-50 font-medium text-blue-700"
        >
          文件管理
        </router-link>
      </div>
    </nav>
    <router-view />
  </div>
</template>
