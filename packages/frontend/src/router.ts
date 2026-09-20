import { createRouter, createWebHistory } from "vue-router";
import Analytics from "./views/Analytics.vue";
import AuditList from "./views/AuditList.vue";
import CreateTask from "./views/CreateTask.vue";
import Files from "./views/Files.vue";
import MarksList from "./views/MarksList.vue";
import TaskDetail from "./views/TaskDetail.vue";
import TaskList from "./views/TaskList.vue";
import VideoList from "./views/VideoList.vue";

const routes = [
  { path: "/", name: "create", component: CreateTask },
  { path: "/tasks", name: "tasks", component: TaskList },
  { path: "/tasks/:id", name: "task-detail", component: TaskDetail },
  { path: "/files", name: "files", component: Files },
  { path: "/audit", name: "audit", component: AuditList },
  { path: "/videos", name: "videos", component: VideoList },
  { path: "/marks", name: "marks", component: MarksList },
  { path: "/analytics", name: "analytics", component: Analytics },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
