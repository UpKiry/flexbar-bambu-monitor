<template>
  <v-container>
    <div class="status-line">
      <span class="status-dot" :class="statusClass"></span>
      <span class="status-text">{{ statusText }}</span>
    </div>

    <v-btn color="primary" :loading="opening" :disabled="opening" @click="openAdmin">
      进入后台
    </v-btn>

    <p class="hint">登录、选择打印机和查看诊断都在浏览器后台完成。</p>

    <v-alert v-if="message" :type="messageType" dense outlined class="mt-4">
      {{ message }}
    </v-alert>

    <v-alert v-if="fallbackUrl" type="info" dense outlined class="mt-4">
      浏览器没有自动打开。请手动访问：
      <a :href="fallbackUrl" target="_blank" rel="noreferrer">{{ fallbackUrl }}</a>
    </v-alert>

    <v-alert v-if="credentialWarning" type="warning" dense outlined class="mt-4">
      {{ credentialWarning }}
    </v-alert>
  </v-container>
</template>

<script>
// 后端刚重启时可能暂时没有响应，不能让设置页一直转圈。
const BACKEND_TIMEOUT_MS = 20000;

export default {
  data() {
    return {
      authState: "signed-out",
      printerName: "",
      credentialWarning: "",
      opening: false,
      message: "",
      messageType: "success",
      fallbackUrl: "",
      pollTimer: null,
    };
  },
  computed: {
    statusClass() {
      if (this.authState === "signed-in") return "success";
      if (this.authState === "expired") return "error";
      return "muted";
    },
    statusText() {
      if (this.authState === "signed-in") {
        return this.printerName ? `已登录 · ${this.printerName}` : "已登录 · 尚未选择打印机";
      }
      if (this.authState === "expired") return "登录已失效，请进入后台重新登录";
      return "未登录，请进入后台登录";
    },
  },
  methods: {
    async sendToBackend(payload) {
      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("插件后端没有响应，请稍后重试")), BACKEND_TIMEOUT_MS);
        if (typeof timer.unref === "function") timer.unref();
      });
      return Promise.race([this.$fd.sendToBackend(payload), timeout]);
    },
    async loadStatus() {
      try {
        const result = await this.sendToBackend({ action: "status" });
        if (result?.status !== "success") {
          throw new Error(result?.message || "读取状态失败");
        }
        this.authState = result.auth?.state || "signed-out";
        this.printerName = result.config?.printerName || "";
        if (result.credentialStore && result.credentialStore.available === false) {
          this.credentialWarning = `系统安全存储不可用（${result.credentialStore.reason || "原因未知"}），登录状态只保留到插件重启为止。`;
        } else {
          this.credentialWarning = "";
        }
      } catch (error) {
        this.authState = "signed-out";
        this.message = error?.message || "读取插件状态失败";
        this.messageType = "error";
      }
    },
    async openAdmin() {
      this.opening = true;
      this.message = "";
      this.fallbackUrl = "";
      try {
        const result = await this.sendToBackend({ action: "openAdmin" });
        if (result?.status !== "success") {
          this.message = result?.message || "无法打开浏览器后台";
          this.messageType = "error";
          return;
        }
        if (result.opened) {
          this.message = "已在浏览器打开后台";
          this.messageType = "success";
        } else {
          this.fallbackUrl = result.url || "";
          this.message = result.message || "请手动打开后台地址";
          this.messageType = "warning";
        }
      } catch (error) {
        this.message = error?.message || "打开浏览器后台失败";
        this.messageType = "error";
      } finally {
        this.opening = false;
      }
    },
  },
  mounted() {
    this.loadStatus();
    // 设置页只需要低频展示登录/打印机状态，实时信息在浏览器后台查看。
    this.pollTimer = setInterval(() => this.loadStatus(), 10000);
  },
  beforeUnmount() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  },
};
</script>

<style scoped>
.status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #9e9e9e;
  flex: none;
}
.status-dot.success {
  background: #2e7d32;
}
.status-dot.error {
  background: #c62828;
}
.status-dot.muted {
  background: #9e9e9e;
}
.status-text {
  font-weight: 500;
}
.hint {
  margin-top: 12px;
  color: inherit;
  opacity: 0.7;
  font-size: 13px;
}
.mt-4 {
  margin-top: 16px;
}
a {
  word-break: break-all;
}
</style>
