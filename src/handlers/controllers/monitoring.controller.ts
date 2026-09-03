import type { Response, Request } from 'express'
import { codeiumService } from '../../services/codeium'

class MonitoringController {
    async health(req: Request, res: Response) {
        try {
            res.json({
                status: true,
                message: '',
                result: {
                    // A dead language server is otherwise indistinguishable from
                    // "the model had no suggestion" (§9).
                    codeium: codeiumService.health(),
                }
            })

        } catch (err: any) {
            if (err instanceof Error) {
                 res.json({
                    status: false,
                    message: err.message,
                    result: null
                })
                return
            }
            res.json({
                status: false,
                message: "Something Went Wrong",
                result: null
            })
            return
        }
    }
    async metrics(req: Request, res: Response) {
        try {
            res.json({
                status: true,
                message: '',
                result: {}
            })

        } catch (err: any) {
            if (err instanceof Error) {
                res.json({
                    status: false,
                    message: err.message,
                    result: null
                })
                return
            }
            res.json({
                status: false,
                message: "Something Went Wrong",
                result: null
            })
            return

        }
    }
    async status(req: Request, res: Response) {
        try {
            res.json({
                status: true,
                message: '',
                result: {}
            })

        } catch (err: any) {
            if (err instanceof Error) {
                 res.json({
                    status: false,
                    message: err.message,
                    result: null
                })
                return
            }
             res.json({
                status: false,
                message: "Something Went Wrong",
                result: null
            })
            return

        }
    }
}
export default new MonitoringController()