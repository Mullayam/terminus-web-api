import type { Response, Request } from 'express'

class TerminalSessionController {
    async create(req: Request, res: Response) {
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
    async getSingleSession(req: Request, res: Response) {
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
    async updatePermission(req: Request, res: Response) {
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
    async deleteSession(req: Request, res: Response) {
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
export default new TerminalSessionController()