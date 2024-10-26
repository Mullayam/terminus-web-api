"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class KeyVaultController {
    async create(req, res) {
        try {
            res.json({
                status: true,
                message: '',
                result: {
                    token: 'your_jwt_token'
                }
            });
        }
        catch (err) {
            res.json({
                status: false,
                message: '',
                result: {
                    token: 'your_jwt_token'
                }
            });
        }
    }
    async list(req, res) {
        try {
            res.json({
                status: true,
                message: '',
                result: {
                    token: 'your_jwt_token'
                }
            });
        }
        catch (err) {
            res.json({
                status: false,
                message: '',
                result: {
                    token: 'your_jwt_token'
                }
            });
        }
    }
    async update(req, res) {
        try {
            res.json({
                status: true,
                message: '',
                result: {}
            });
        }
        catch (err) {
            res.json({
                status: false,
                message: '',
                result: {}
            });
        }
    }
    async delete(req, res) {
        try {
            res.json({
                status: true,
                message: '',
                result: {}
            });
        }
        catch (err) {
            res.json({
                status: false,
                message: '',
                result: {
                    token: 'your_jwt_token'
                }
            });
        }
    }
}
exports.default = new KeyVaultController();
