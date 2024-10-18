import type { Response, Request } from 'express'

class KeyVaultController {
    async create(req: Request, res: Response) {
        try {
            res.json({
                status: true,
                message: '',
                result: {
                    token: 'your_jwt_token'
                }
            })

        } catch (err) {
            res.json({
                status: false,
                message: '',
                result: {
                    token: 'your_jwt_token'
                }
            })

        }
    }
    async list(req: Request, res: Response) {
        try {
            res.json({
                status: true,
                message: '',
                result: {
                    token: 'your_jwt_token'
                }
            })

        } catch (err) {
            res.json({
                status: false,
                message: '',
                result: {
                    token: 'your_jwt_token'
                }
            })

        }
    }
    async update(req: Request, res: Response) {
        try {
            res.json({
                status: true,
                message: '',
                result: {
                    
                }
            })

        } catch (err) {
            res.json({
                status: false,
                message: '',
                result: {
                   
                }
            })

        }
    }
    async delete(req: Request, res: Response) {
        try {
            res.json({
                status: true,
                message: '',
                result: {
                     
                }
            })

        } catch (err) {
            res.json({
                status: false,
                message: '',
                result: {
                    token: 'your_jwt_token'
                }
            })

        }
    }

}
export default new KeyVaultController()