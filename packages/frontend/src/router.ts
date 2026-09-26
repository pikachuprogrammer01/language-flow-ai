import { createRouter, createWebHistory } from "vue-router";
import Analytics from "./views/Analytics.vue";
import AuditList from "./views/AuditList.vue";
import CreateTask from "./views/CreateTask.vue";
import Dashboard from "./views/Dashboard.vue";
import Files from "./views/Files.vue";
import InsightsData from "./views/InsightsData.vue";
import InsightsExperiments from "./views/InsightsExperiments.vue";
import InsightsFactors from "./views/InsightsFactors.vue";
import InsightsOverview from "./views/InsightsOverview.vue";
import InsightsVideoDetail from "./views/InsightsVideoDetail.vue";
import InsightsVideos from "./views/InsightsVideos.vue";
import MarksList from "./views/MarksList.vue";
import TaskDetail from "./views/TaskDetail.vue";
import TaskList from "./views/TaskList.vue";
import VideoList from "./views/VideoList.vue";

const routes = [
  { path: "/", name: "dashboard", component: Dashboard, meta: { title: "工作台" } },
  { path: "/create", name: "create", component: CreateTask, meta: { title: "新建视频" } },
  { path: "/tasks", name: "tasks", component: TaskList, meta: { title: "生成记录" } },
  { path: "/tasks/:id", name: "task-detail", component: TaskDetail, meta: { title: "生成记录" } },
  { path: "/files", name: "files", component: Files, meta: { title: "文件管理" } },
  { path: "/audit", name: "audit", component: AuditList, meta: { title: "审计管理" } },
  { path: "/videos", name: "videos", component: VideoList, meta: { title: "视频资产" } },
  { path: "/marks", name: "marks", component: MarksList, meta: { title: "上传标记" } },
  { path: "/analytics", name: "analytics", component: Analytics, meta: { title: "发布管理" } },
  { path: "/insights", name: "insights", component: InsightsOverview, meta: { title: "数据分析" } },
  {
    path: "/insights/factors",
    name: "insights-factors",
    component: InsightsFactors,
    meta: { title: "因子分析" },
  },
  {
    path: "/insights/experiments",
    name: "insights-experiments",
    component: InsightsExperiments,
    meta: { title: "内容实验" },
  },
  {
    path: "/insights/data",
    name: "insights-data",
    component: InsightsData,
    meta: { title: "数据接入" },
  },
  {
    path: "/insights/videos",
    name: "insights-videos",
    component: InsightsVideos,
    meta: { title: "视频表现" },
  },
  {
    path: "/insights/videos/:id",
    name: "insights-video-detail",
    component: InsightsVideoDetail,
    meta: { title: "单视频分析" },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
