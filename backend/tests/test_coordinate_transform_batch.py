"""GCJ02 → WGS84 批量转换（numpy）与逐点实现一致性。

背景：图层保存整层逆转换原为逐点标量调用（百万级节点需数十秒），
新增 gcj02_to_wgs84_batch 后按 numpy 向量化；此处确保与标量结果一致。

逆向经固定点迭代求解（w ← g - offset(w)），与正向转换严格互逆，
往返应位级相同且反复往返不漂移。
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


def test_wgs84_gcj02_roundtrip_exact():
    """WGS84 → GCJ02 → WGS84 往返应位级相同（固定点迭代求逆）。"""
    rng = np.random.default_rng(7)
    wgs_lats = rng.uniform(20.0, 45.0, 300)
    wgs_lngs = rng.uniform(100.0, 130.0, 300)
    gcj_lats, gcj_lngs = CT.wgs84_to_gcj02_batch(wgs_lats, wgs_lngs)
    back_lats, back_lngs = CT.gcj02_to_wgs84_batch(gcj_lats, gcj_lngs)
    assert np.array_equal(back_lats, wgs_lats)
    assert np.array_equal(back_lngs, wgs_lngs)


def test_repeated_roundtrip_no_drift():
    """反复正反向转换 10 次不产生累积位移（旧一阶近似会线性漂移）。"""
    wgs_lats = np.array([39.9087, 31.2304, 23.1291, 22.5431, 30.5728])
    wgs_lngs = np.array([116.3975, 121.4737, 113.2644, 114.0579, 104.0668])
    cur_lats, cur_lngs = wgs_lats, wgs_lngs
    for _ in range(10):
        g_lats, g_lngs = CT.wgs84_to_gcj02_batch(cur_lats, cur_lngs)
        cur_lats, cur_lngs = CT.gcj02_to_wgs84_batch(g_lats, g_lngs)
    assert np.array_equal(cur_lats, wgs_lats)
    assert np.array_equal(cur_lngs, wgs_lngs)


def test_gcj_offsets_outside_china_zero():
    """偏移场 helper：境外点偏移精确为 0。"""
    lats = np.array([0.0, 60.0, -10.0])
    lngs = np.array([0.0, 140.0, 100.0])
    d_lat, d_lng = CT._gcj_offsets_batch(lats, lngs)
    assert np.array_equal(d_lat, np.zeros_like(d_lat))
    assert np.array_equal(d_lng, np.zeros_like(d_lng))
