<template>
  <v-container>
    <v-select v-model="printerId" :items="printerOptions" item-title="title" item-value="value"
      label="打印机" hide-details @update:modelValue="emitUpdate" />
    <p v-if="devicesMessage">{{ devicesMessage }}</p>
    <v-btn variant="text" :loading="loading" @click="loadDevices(true)">刷新打印机列表</v-btn>
  </v-container>
</template>

<script>
export default {
  name: "MonitorSettings",
  props: { modelValue: { type: Object, required: true } },
  emits: ["update:modelValue"],
  data() {
    return { printerId: "", devices: [], devicesMessage: "", loading: false };
  },
  computed: {
    printerOptions() {
      const options = [{ title: "使用后台默认打印机", value: "" }, ...this.devices.map((device) => ({ title: device.name || device.id, value: device.id }))];
      if (this.printerId && !this.devices.some((device) => device.id === this.printerId)) {
        options.push({ title: `已选设备（${this.printerId}）`, value: this.printerId });
      }
      return options;
    },
  },
  watch: {
    modelValue: {
      deep: true,
      handler() {
        this.printerId = typeof this.modelValue?.data?.printerId === "string" ? this.modelValue.data.printerId : "";
      },
    },
  },
  methods: {
    async loadDevices(refresh = false) {
      this.loading = true;
      try {
        const result = await this.$fd.sendToBackend({ action: refresh ? "refreshDevices" : "status" });
        if (result?.status !== "success") throw new Error(result?.message || "无法读取设备列表");
        this.devices = Array.isArray(result.devices) ? result.devices : [];
        this.devicesMessage = result.devicesError || (!this.devices.length ? "请先在后台登录并刷新设备列表" : "");
      } catch (error) {
        this.devicesMessage = error?.message || "无法读取设备列表";
      } finally {
        this.loading = false;
      }
    },
    emitUpdate() {
      const model = this.modelValue && typeof this.modelValue === "object" ? this.modelValue : {};
      const data = model.data && typeof model.data === "object" ? model.data : {};
      this.$emit("update:modelValue", {
        ...model,
        data: { ...data, printerId: this.printerId || "" },
      });
    },
  },
  mounted() {
    this.printerId = typeof this.modelValue?.data?.printerId === "string" ? this.modelValue.data.printerId : "";
    this.loadDevices();
  },
};
</script>

<style scoped></style>
