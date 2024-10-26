"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class AuthController {
    async login(req, res) {
        try {
            res.json({
                status: true,
                message: 'Login Successful',
                result: {
                    token: 'your_jwt_token'
                }
            });
        }
        catch (err) {
            res.json({
                status: false,
                message: 'Login Successful',
                result: {
                    token: 'your_jwt_token'
                }
            });
        }
    }
    async register(req, res) {
        try {
            res.json({
                status: true,
                message: 'register Successful',
                result: {
                    token: 'your_jwt_token'
                }
            });
        }
        catch (err) {
            if (err instanceof Error) {
                res.json({
                    status: false,
                    message: err.message,
                    result: null
                });
            }
            res.json({
                status: false,
                message: "Something Went Wrong",
                result: null
            });
        }
    }
    async refresh(req, res) {
        try {
            res.json({
                status: true,
                message: 'refresh Successful',
                result: {}
            });
        }
        catch (err) {
            if (err instanceof Error) {
                res.json({
                    status: false,
                    message: err.message,
                    result: null
                });
            }
            res.json({
                status: false,
                message: "Something Went Wrong",
                result: null
            });
        }
    }
}
exports.default = new AuthController();
