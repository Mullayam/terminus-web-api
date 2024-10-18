import { Router } from 'express'
import { MonitoringController } from '@/handlers/ctrl';

const router = Router();

router.get('/health', MonitoringController.default.health);
router.get('/status ', MonitoringController.default.status);
router.get('/metrics',MonitoringController.default.metrics);

export default router


