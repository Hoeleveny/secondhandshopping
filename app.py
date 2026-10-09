"""Flask 应用工厂。

启动：
    .venv\\Scripts\\python.exe app.py
或：
    .venv\\Scripts\\python.exe -m flask --app app:create_app run --port 5000
"""
from pathlib import Path

from flask import Flask, jsonify, render_template, send_from_directory

from config import Config
from extensions import bcrypt, db, jwt


def create_app(config_object=Config) -> Flask:
    app = Flask(__name__)
    app.config.from_object(config_object)

    # 上传目录必须存在
    Path(app.config["UPLOAD_FOLDER"]).mkdir(parents=True, exist_ok=True)
    Path(app.config["BACKUP_DIR"]).mkdir(parents=True, exist_ok=True)

    db.init_app(app)
    bcrypt.init_app(app)
    jwt.init_app(app)

    _register_jwt_handlers(app)
    _register_error_handlers(app)

    # 业务接口（各模块蓝图）
    from api import register_blueprints

    register_blueprints(app)

    # ---- 页面与静态资源 ----
    @app.get("/")
    def index():
        """单页外壳：三段式布局，内容区由前端 hash 路由切换。"""
        return render_template("index.html")

    @app.get("/uploads/<path:filename>")
    def uploaded_file(filename: str):
        return send_from_directory(app.config["UPLOAD_FOLDER"], filename)

    @app.get("/api/health")
    def health():
        return jsonify(code=0, msg="ok", data={"service": "campus-market"})

    return app


def _register_jwt_handlers(app: Flask) -> None:
    """JWT 失败时也返回统一的 {code, msg, data} 结构，前端好处理。"""
    from flask_jwt_extended import JWTManager  # noqa: F401  (确保扩展已注册)

    @jwt.unauthorized_loader
    def _unauthorized(reason: str):
        return jsonify(code=401, msg="请先登录", data=None), 401

    @jwt.invalid_token_loader
    def _invalid_token(reason: str):
        return jsonify(code=401, msg="登录状态无效，请重新登录", data=None), 401

    @jwt.expired_token_loader
    def _expired_token(header, payload):
        return jsonify(code=401, msg="登录已过期，请重新登录", data=None), 401


def _register_error_handlers(app: Flask) -> None:
    from werkzeug.exceptions import HTTPException

    @app.errorhandler(HTTPException)
    def _http_error(exc: HTTPException):
        return jsonify(code=exc.code, msg=exc.description, data=None), exc.code

    @app.errorhandler(Exception)
    def _server_error(exc: Exception):
        app.logger.exception("未捕获的异常")
        return jsonify(code=500, msg=f"服务器内部错误：{exc}", data=None), 500


app = create_app()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
