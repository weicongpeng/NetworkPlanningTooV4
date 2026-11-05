"""
测试 GeoFieldDetector 字段检测与坐标验证

覆盖回归场景：
- test_latitude_not_matched_by_single_y: 含 y 的无关列（ssbFrequency）不被误判为纬度
- test_managed_element_type_not_latitude: ManagedElementType 不被误判为纬度
- test_cell_longitude_latitude_detected: 英文 CellLongitude/CellLatitude 正确检测
- test_chinese_longitude_latitude_detected: 中文 经度/纬度 正确检测
- test_coordinate_validation_passes: 真实坐标验证通过
"""
import pandas as pd

from app.services.geo_field_detector import GeoFieldDetector


class TestGeoFieldDetector:
    """字段检测回归测试（修复单字母 X/Y 误匹配 bug）"""

    def setup_method(self):
        self.detector = GeoFieldDetector()

    def test_latitude_not_matched_by_single_y(self):
        """含 y 的无关列 ssbFrequency 不应抢占纬度列"""
        df = pd.DataFrame({
            'CGI': ['a'],
            'CellName': ['b'],
            'ssbFrequency': [1870.0],
            '经度': [114.6],
            '纬度': [24.1],
        })
        fields = self.detector.detect_fields(df)
        assert fields['longitude'] == '经度'
        assert fields['latitude'] == '纬度'

    def test_managed_element_type_not_latitude(self):
        """ManagedElementType 含 y 但不应该被误判为纬度列"""
        df = pd.DataFrame({
            'CGI': ['a'],
            'ManagedElementType': ['ITBBU'],
            'SubNetwork': ['x'],
            'ManagedElement': ['y'],
            'gNBId': [1],
            'cellLocalId': [2],
            'NE_Name': ['n'],
            'gNBName': ['g'],
            'CellName': ['c'],
            'pci': [1],
            'ssbFrequency': [1],
            '经度': [114.6],
            '纬度': [24.1],
        })
        fields = self.detector.detect_fields(df)
        assert fields['longitude'] == '经度'
        assert fields['latitude'] == '纬度'

    def test_cell_longitude_latitude_detected(self):
        """英文 CellLongitude/CellLatitude 应正确检测"""
        df = pd.DataFrame({
            '是否在网': ['是'],
            'CGI': ['c'],
            'CellLongitude': [114.96],
            'CellLatitude': [24.19],
            'TAC': [1],
            '方向角': [40],
        })
        fields = self.detector.detect_fields(df)
        assert fields['longitude'] == 'CellLongitude'
        assert fields['latitude'] == 'CellLatitude'
        assert fields['azimuth'] == '方向角'
        assert fields['geometry_type'] == 'sector'

    def test_chinese_longitude_latitude_detected(self):
        """中文 经度/纬度 应正确检测"""
        df = pd.DataFrame({
            '经度': [114.668744],
            '纬度': [24.1],
        })
        fields = self.detector.detect_fields(df)
        assert fields['longitude'] == '经度'
        assert fields['latitude'] == '纬度'

    def test_columns_with_x_y_letters_not_matched(self):
        """含 X/Y 字母但语义无关的列不应被匹配为经纬度"""
        df = pd.DataFrame({
            'ManagedElement': ['y'],
            'SubNetwork': ['x'],
            'PolygonType': ['polygon-x'],
            'Frequency': [1.0],
        })
        fields = self.detector.detect_fields(df)
        assert fields['longitude'] is None
        assert fields['latitude'] is None

    def test_coordinate_validation_passes(self):
        """真实坐标（纬度 24.x）应通过坐标验证"""
        df = pd.DataFrame({
            '经度': [114.668744, 114.790990],
            '纬度': [24.196389, 24.018040],
        })
        is_valid, _ = self.detector.validate_coordinates(df, '经度', '纬度')
        assert is_valid is True

    def test_coordinate_validation_rejects_out_of_range(self):
        """纬度超出范围（如 3408.96）应验证失败"""
        df = pd.DataFrame({
            '经度': [114.668744],
            '纬度': [3408.96],
        })
        is_valid, error_msg = self.detector.validate_coordinates(df, '经度', '纬度')
        assert is_valid is False
        assert '3408.96' in error_msg
