"""制式分离查重与新站录入重复消息测试"""
import pytest
from app.services.data_service import data_service


def test_duplicate_message_same_type():
    """同制式重复 → '已重复，信息已更新覆盖'"""
    assert data_service._duplicate_message("NR", "NR", "X") == "[NR]小区 X 已重复，信息已更新覆盖"
    assert data_service._duplicate_message("LTE", "LTE", "Y") == "[LTE]小区 Y 已重复，信息已更新覆盖"


def test_duplicate_message_cross_type():
    """跨制式重复 → '已在[其他制式]工参中存在，请检查'"""
    assert data_service._duplicate_message("LTE", "NR", "X") == "[LTE]小区 X 已在[NR]工参中存在，请检查"
    assert data_service._duplicate_message("NR", "LTE", "Y") == "[NR]小区 Y 已在[LTE]工参中存在，请检查"
