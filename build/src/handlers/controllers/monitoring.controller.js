"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class MonitoringController {
    async health(req, res) {
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
    async metrics(req, res) {
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
    async status(req, res) {
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
exports.default = new MonitoringController();
