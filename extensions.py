"""Flask 扩展实例。

单独放一个模块，避免 app.py 与各接口模块之间循环导入。
"""
from flask_bcrypt import Bcrypt
from flask_jwt_extended import JWTManager
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()
bcrypt = Bcrypt()
jwt = JWTManager()
