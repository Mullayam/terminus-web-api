import type { Response, Request } from 'express'
class AuthController {
    async login(req: Request, res: Response) {
        try {
            res.json({
                status: true,
                message: 'Login Successful',
                result: {
                    token: 'your_jwt_token'
                }
            })

        } catch (err) {
            res.json({
                status: false,
                message: 'Login Successful',
                result: {
                    token: 'your_jwt_token'
                }
            })

        }
    }

    async register(req: Request, res: Response) {
        try {
            res.json({
                status: true,
                message: 'register Successful',
                result: {
                    token: 'your_jwt_token'
                }
            })

        } catch (err) {
            if (err instanceof Error) {
                res.json({
                    status: false,
                    message: err.message,
                    result: null
                })
            }
            res.json({
                status: false,
                message: "Something Went Wrong",
                result: null
            })

        }
    }
    async refresh(req: Request, res: Response) {
        try {
            res.json({
                status: true,
                message: 'refresh Successful',
                result: {}
            })

        } catch (err: any) {
            if (err instanceof Error) {
                res.json({
                    status: false,
                    message: err.message,
                    result: null
                })
            }
            res.json({
                status: false,
                message: "Something Went Wrong",
                result: null
            })

        }
    }
}
export default new AuthController()