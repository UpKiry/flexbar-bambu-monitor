<template>
  <v-container>
    <v-radio-group v-model="view" label="按键视图" hide-details @update:modelValue="emitUpdate">
      <v-radio v-for="item in views" :key="item.value" :label="item.label" :value="item.value" />
    </v-radio-group>
  </v-container>
</template>

<script>
const VIEWS = [
  { value: "progress", label: "进度" },
  { value: "temperature", label: "温度" },
  { value: "task", label: "任务信息" },
];

export default {
  name: "MonitorSettings",
  props: { modelValue: { type: Object, required: true } },
  emits: ["update:modelValue"],
  data() {
    return { view: "progress", views: VIEWS };
  },
  watch: {
    modelValue: {
      deep: true,
      handler() {
        this.view = this.readView();
      },
    },
  },
  methods: {
    readView() {
      const value = this.modelValue?.data?.view;
      return VIEWS.some((item) => item.value === value) ? value : "progress";
    },
    emitUpdate() {
      const model = this.modelValue && typeof this.modelValue === "object" ? this.modelValue : {};
      const data = model.data && typeof model.data === "object" ? model.data : {};
      this.$emit("update:modelValue", {
        ...model,
        data: { ...data, view: this.view },
      });
    },
  },
  mounted() {
    this.view = this.readView();
  },
};
</script>

<style scoped></style>
