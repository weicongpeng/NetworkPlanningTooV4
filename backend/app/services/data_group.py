"""
数据分组（地市+运营商）归属与可见性工具

数据空间按 (city, operator) 分组隔离，数据归组所有（快照语义）：
- 写入路径盖章：上传/创建数据时从操作者（或其操作的工参所属组）复制组信息；
- 查询路径过滤：所有用户（含管理员）一律仅见同组数据，不设跨组特权；
- 用户组信息缺失（city/operator NULL）不可见任何业务数据；
- 存量无标记数据（city/operator 为 NULL）启动时迁移归入主管理员所在组。
"""
from typing import Any, Optional, Tuple

from sqlalchemy import false
from sqlalchemy.sql.elements import ColumnElement

from app.core.config import settings

# 运营商固定选项（唯一来源）
OPERATORS: list = ["移动", "联通", "电信", "广电"]


def is_admin(user) -> bool:
    """是否管理员（仅用于权限功能判断，不参与数据可见性——管理员同样按组隔离）"""
    return bool(getattr(user, "is_admin", False))


def user_group(user) -> Optional[Tuple[str, str]]:
    """返回用户的 (city, operator) 组；信息不全返回 None"""
    if user is None:
        return None
    city = getattr(user, "city", None)
    operator = getattr(user, "operator", None)
    if not city or not operator:
        return None
    return (city, operator)


def group_sql_filter(city_col, operator_col, user) -> Optional[ColumnElement]:
    """生成 SQLAlchemy 组过滤表达式。

    返回 None 表示不过滤（仅系统内部调用 user=None）；用户组信息缺失返回永假条件（查不到任何行）。
    管理员与普通用户一律按组隔离，不设跨组特权。
    用法：query.filter(...) 组合，例如
        f = group_sql_filter(Sector.city, Sector.operator, user)
        if f is not None:
            query = query.filter(f)
    """
    if user is None:
        return None
    group = user_group(user)
    if group is None:
        return false()
    return (city_col == group[0]) & (operator_col == group[1])


def index_entry_visible(entry: dict, user) -> bool:
    """内存索引条目可见性。条目缺 city/operator 键视为存量数据 → 仅
    归属组与条目组完全相等时可见。user 为 None 视为系统内部调用，不做过滤。"""
    if user is None:
        return True
    group = user_group(user)
    if group is None:
        return False
    return entry.get("city") == group[0] and entry.get("operator") == group[1]


def stamp_group(target: Any, city: Optional[str], operator: Optional[str]) -> None:
    """给 ORM 行或 dict 条目盖章组信息"""
    if target is None:
        return
    if isinstance(target, dict):
        target["city"] = city
        target["operator"] = operator
    else:
        target.city = city
        target.operator = operator


def validate_group(city: Optional[str], operator: Optional[str]) -> Optional[str]:
    """校验组信息合法性（注册/建号）。返回错误消息或 None。"""
    if not city:
        return "请选择地市"
    if not operator:
        return "请选择运营商"
    if city not in settings.CITY_PRESETS:
        return f"地市「{city}」不在预设列表中"
    if operator not in OPERATORS:
        return f"运营商「{operator}」无效，仅支持：{'、'.join(OPERATORS)}"
    return None


# 带 (city, operator) 组归属快照列、且有 user_id 可按用户过滤的业务表
# （与 app/core/database.py 的建表/存量迁移清单保持一致）
USER_SCOPED_GROUP_TABLES = (
    "workbooks", "sites", "sectors", "geo_files", "layers",
    "station_param_rows", "station_metric_rows",
)
# task_results 无 user_id，按创建人 user_name 过滤
TASK_RESULTS_TABLE = "task_results"


def migrate_group_data(
    db,
    *,
    user_id: int,
    username: str,
    old_city: str,
    old_operator: str,
    new_city: str,
    new_operator: str,
    scope: str,
) -> dict:
    """管理员修改用户的（地市+运营商）组后，级联迁移历史数据归属。

    scope="user"：仅迁移该用户自己产生的历史记录；
    scope="group"：迁移旧组下所有成员的全部记录（组改名/整体迁移场景）。

    覆盖：8 张 SQLite 业务表 + data_service 内存索引(index.json)。
    所有 UPDATE 都带旧组条件，防止误改已属别组的行；单事务，失败回滚。
    返回各表迁移行数统计。
    """
    from sqlalchemy import text, bindparam
    from app.core.database import SessionLocal
    from app.services.data_service import data_service

    if scope not in ("user", "group"):
        raise ValueError(f"无效的迁移范围: {scope}")
    if not (old_city and old_operator and new_city and new_operator):
        raise ValueError("新旧组信息必须完整")

    counts: dict = {}
    params: dict = {"nc": new_city, "no": new_operator,
                    "oc": old_city, "oo": old_operator}

    # 单例工参（全量工参/待规划小区）按组只保留一份：记录迁移范围内将带入新组的
    # 单例类型，迁移完成后覆盖（删除）新组已有的同类型旧工参，避免出现两份。
    SINGLETON_TYPES = ("full_params", "target_cells")
    if scope == "user":
        params["uid"] = user_id
        moved_rows = db.execute(
            text("SELECT id, file_type FROM workbooks "
                 "WHERE user_id = :uid AND city = :oc AND operator = :oo"),
            params,
        ).fetchall()
    else:
        moved_rows = db.execute(
            text("SELECT id, file_type FROM workbooks "
                 "WHERE city = :oc AND operator = :oo"),
            params,
        ).fetchall()
    moved_singleton_types = {r[1] for r in moved_rows if r[1] in SINGLETON_TYPES}
    # 新组中已存在、且与迁入类型冲突的旧工参（必须在 UPDATE 前识别）
    conflict_wb_ids: list = []
    if moved_singleton_types:
        conflict_rows = db.execute(
            text("SELECT id FROM workbooks WHERE city = :nc AND operator = :no "
                 "AND file_type IN :ftypes").bindparams(
                bindparam("ftypes", expanding=True)),
            {**params, "ftypes": tuple(moved_singleton_types)},
        ).fetchall()
        conflict_wb_ids = [r[0] for r in conflict_rows]

    if scope == "user":
        params["uid"] = user_id
        for table in USER_SCOPED_GROUP_TABLES:
            result = db.execute(
                text(
                    f"UPDATE {table} SET city = :nc, operator = :no "
                    f"WHERE user_id = :uid AND city = :oc AND operator = :oo"
                ),
                params,
            )
            counts[table] = result.rowcount
        result = db.execute(
            text(
                f"UPDATE {TASK_RESULTS_TABLE} SET city = :nc, operator = :no "
                f"WHERE user_name = :uname AND city = :oc AND operator = :oo"
            ),
            {**params, "uname": username},
        )
        counts[TASK_RESULTS_TABLE] = result.rowcount
    else:
        for table in (*USER_SCOPED_GROUP_TABLES, TASK_RESULTS_TABLE):
            result = db.execute(
                text(
                    f"UPDATE {table} SET city = :nc, operator = :no "
                    f"WHERE city = :oc AND operator = :oo"
                ),
                params,
            )
            counts[table] = result.rowcount

    db.commit()

    # 内存索引（index.json）条目同步迁移
    index_count = 0
    try:
        from app.services import dataset_revision_service as revs

        for entry in data_service.index.values():
            if entry.get("city") != old_city or entry.get("operator") != old_operator:
                continue
            if scope == "user" and entry.get("user_id") != user_id:
                continue
            entry["city"] = new_city
            entry["operator"] = new_operator
            index_count += 1
            # 归属变了 → 旧组看不到、新组看得到，等于数据对两端都变了
            revs.bump(entry.get("id"), deleted=False)
        if index_count:
            data_service._save_index()
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"[组迁移] 索引条目迁移失败（不影响数据库）: {e}")

    # 覆盖语义：新组已有的同类型单例工参（全量工参/待规划小区）删除，
    # 保证迁入后新组每种工参只有一份（迁入的覆盖原有的），而非追加成两份。
    overwritten = []
    for wb_id in conflict_wb_ids:
        try:
            # delete_data 清文件+索引+sites/sectors（id 不在索引时返回 False）
            data_service.delete_data(wb_id)
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(f"[组迁移] 覆盖新组旧工参失败 {wb_id}: {e}")
        # DB 兜底：保证旧工参及其全部子表行删除（含 station 动态参数/指标表）
        for _t in ("sectors", "sites", "station_param_rows", "station_metric_rows"):
            db.execute(text(f"DELETE FROM {_t} WHERE workbook_id = :id"), {"id": wb_id})
        db.execute(text("DELETE FROM workbooks WHERE id = :id"), {"id": wb_id})
        db.commit()
        overwritten.append(wb_id)

    # 覆盖了全量工参：新组旧的"已应用"规划结果失效，重置应用标记
    reset_applied = 0
    if "full_params" in moved_singleton_types and overwritten:
        try:
            from app.models.database import TaskResult
            reset_db = SessionLocal()
            try:
                reset_applied = reset_db.query(TaskResult).filter(
                    TaskResult.city == new_city,
                    TaskResult.operator == new_operator,
                    TaskResult.is_applied == 1,
                ).update({"is_applied": 0})
                reset_db.commit()
            finally:
                reset_db.close()
        except Exception:
            pass

    # 失效地图数据缓存与小区搜索索引（遵守地图缓存失效约定）
    try:
        from app.api.v1.endpoints.map import invalidate_map_data_cache
        invalidate_map_data_cache()
    except Exception:
        pass
    try:
        data_service._invalidate_cell_search_index()
    except Exception:
        pass

    return {
        "scope": scope,
        "old_group": [old_city, old_operator],
        "new_group": [new_city, new_operator],
        "tables": counts,
        "index_entries": index_count,
        "overwritten_workbooks": overwritten,
        "reset_applied_tasks": reset_applied,
        "total": sum(counts.values()),
    }
