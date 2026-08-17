import { createRouter, createWebHistory } from "vue-router";
import CreateTask from "./views/CreateTask.vue";

const routes = [{ path: "/", name: "create", component: CreateTask }];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
