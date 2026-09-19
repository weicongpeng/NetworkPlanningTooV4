"""GCJ02 → WGS84 批量转换（numpy）与逐点实现一致性。

背景：图层保存整层逆转换原为逐点标量调用（百万级节点需数十秒），
新增 gcj02_to_wgs84_batch 后按 numpy 向量化；此处确保与标量结果一致。
"""
import numpy as np

from app.utils.coordinate_transformer import CoordinateTransformer as CT


def test_gcj02_to_wgs84_batch_matches_scalar():
    rng = np.random.default_rng(42)
    lats = rng.uniform(20.0, 45.0, 500)
    lngs = rng.uniform(100.0, 130.0, 500)

    b_lats, b_lngs = CT.gcj02_to_wgs84_batch(lats, lngs)
    for i in range(len(lats)):
        s_lat, s_lng = CT.gcj02_to_wgs84(float(lats[i]), float(lngs[i]))
        assert abs(s_lat - b_lats[i]) < 1e-12
        assert abs(s_lng - b_lngs[i]) < 1e-12


def test_gcj02_to_wgs84_batch_outside_china_unchanged():
    # 境外坐标不做纠偏（经度 70 在国界外）
    lats = np.array([10.0, 60.0, 40.0])
    lngs = np.array([10.0, 130.0, 70.0])
    w_lats, w_lngs = CT.gcj02_to_wgs84_batch(lats, lngs)
    assert np.allclose(w_lats, lats)
    assert np.allclose(w_lngs, lngs)


def test_wgs84_gcj02_roundtrip_batch():
    """WGS84 → GCJ02 → WGS84 往返误差应在米级（近似算法）。"""
    wgs_lats = np.array([23.0, 23.5, 24.0])
    wgs_lngs = np.array([114.0, 114.5, 113.8])
    gcj_lats, gcj_lngs = CT.wgs84_to_gcj02_batch(wgs_lats, wgs_lngs)
    back_lats, back_lngs = CT.gcj02_to_wgs84_batch(gcj_lats, gcj_lngs)
    # 0.001 度 ≈ 100m，远大于算法误差（1-2m）
    assert np.allclose(back_lats, wgs_lats, atol=1e-4)
    assert np.allclose(back_lngs, wgs_lngs, atol=1e-4)
