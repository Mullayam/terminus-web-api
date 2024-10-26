"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const ctrl_1 = require("@/handlers/ctrl");
const router = (0, express_1.Router)();
router.get('/health', ctrl_1.MonitoringController.default.health);
router.get('/status ', ctrl_1.MonitoringController.default.status);
router.get('/metrics', ctrl_1.MonitoringController.default.metrics);
exports.default = router;
