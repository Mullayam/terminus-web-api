import { Router } from 'express'
import monitoringRoutes from './monitoring'
import apiRoutes from './api'

const router = Router();

router.use("/api",apiRoutes);
router.use(monitoringRoutes);

export default router


