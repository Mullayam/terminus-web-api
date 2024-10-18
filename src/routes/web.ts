import { Router } from 'express'
import BaseController from '../controllers/BaseController';

const router = Router();

router.post('/upload', BaseController.handleUpload);

export default router


