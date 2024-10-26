"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class TerminalSessionController {
    async create(req, res) {
        try {
            res.json({
                status: true,
                message: '',
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
    async getSingleSession(req, res) {
        try {
            res.json({
                status: true,
                message: '',
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
    async updatePermission(req, res) {
        try {
            res.json({
                status: true,
                message: '',
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
    async deleteSession(req, res) {
        try {
            res.json({
                status: true,
                message: '',
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
exports.default = new TerminalSessionController();
