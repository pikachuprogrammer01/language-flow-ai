import { createRouter, createWebHistory } from "vue-router";
import CreateTask from "./views/CreateTask.vue";
import TaskDetail from "./views/TaskDetail.vue";
import TaskList from "./views/TaskList.vue";

const routes = [
  { path: "/", name: "create", component: CreateTask },
  { path: "/tasks", name: "tasks", component: TaskList },
  { path: "/tasks/:id", name: "task-detail", component: TaskDetail },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
