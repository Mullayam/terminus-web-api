"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
require("reflect-metadata");
const package_json_1 = __importDefault(require("./package.json"));
const tsconfig_paths_1 = require("tsconfig-paths");
(0, tsconfig_paths_1.register)({ baseUrl: __dirname, paths: package_json_1.default.paths });
const application_1 = require("./src/application");
function main() {
    const app = application_1.bootstrap.AppServer.InitailizeApplication();
    const options = {
        dotfiles: 'ignore',
        etag: false,
        extensions: ['htm', 'html'],
        index: false,
        maxAge: '1d',
        redirect: false,
        setHeaders(res, path, stat) {
            res.set('x-timestamp', Date.now());
        }
    };
    app.use(application_1.bootstrap.express.static('public', options));
}
main();
