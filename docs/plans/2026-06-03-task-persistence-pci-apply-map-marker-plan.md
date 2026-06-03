# Task Persistence / PCI Apply / Map Marker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement three features: (1) task state persistence with global progress indicator, (2) PCI apply performance optimization, (3) map search marker style change.

**Architecture:** 
- P0 (PCI apply): Refactor `task_manager.py` `_run_apply_pci_to_params_task` to split Phase 1 (SQLite only, <2s) from Phase 2 (Excel background). Move all `openpyxl` operations and file copies to a true background thread.
- P1 (map marker): Change `setSearchMarker` divIcon in `OnlineMap.tsx` from 24px teardrop to 16px red circle matching the capture-marker style.
- P2 (state persistence): Create dedicated Zustand stores (pciStore, neighborStore, tacCheckStore) to persist wizard state, create GlobalTaskIndicator component, modify pages to use stores.

**Tech Stack:** Python FastAPI (backend), React 18 + TypeScript + Zustand + Tailwind CSS (frontend), Leaflet (maps)

---

## Stage 1: PCI Apply Performance Optimization (P0)

### Task 1.1: Refactor `_run_apply_pci_to_params_task` — Split Phase 1 and Phase 2

**Files:**
- Modify: `backend/app/services/task_manager.py:1450-1864`

**Step 1: Read the current implementation**

Read `task_manager.py` lines 1450-1864 to understand the full apply flow.

**Step 2: Create new `_apply_pci_fast_sqlite_only` method**

Extract a new method from `_sync_apply_pci_fast` that ONLY updates SQLite — no Excel copy, no openpyxl, no file I/O beyond what SQLite needs:

```python
def _apply_pci_fast_sqlite_only(self, planning_result: Dict, progress_holder: list, _logger: logging.Logger) -> Dict:
    """Phase 1: SQLite-only fast path for PCI apply. No Excel I/O.
    
    Target: < 2 seconds even for large datasets.
    """
    try:
        results = planning_result.get("results", [])
        network_type = planning_result.get("networkType", "LTE")
        
        if not results:
            return {"success": False, "message": "没有可应用的PCI规划结果", "updatedCount": 0}

        # 1. Find current full_params in index
        old_entry_id = None
        full_params_info = None
        for entry_id, entry in data_service.index.items():
            if entry.get("fileType") == "full_params":
                full_params_info = entry
                old_entry_id = entry_id
                break
        
        if not full_params_info:
            return {"success": False, "message": "未找到工参数据(full_params)，请先上传工参数据", "updatedCount": 0}

        # 2. Build PCI update map (batch in memory)
        pci_updates = {}
        for item in results:
            site_id = str(item.get("siteId", "")).strip()
            sector_id = str(item.get("sectorId", "")).strip()
            new_pci = item.get("suggestedPCI") or item.get("newPCI")
            if site_id and sector_id and new_pci is not None:
                key = f"{site_id}_{sector_id}"
                pci_updates[key] = int(new_pci)

        if not pci_updates:
            return {"success": False, "message": "PCI更新映射为空", "updatedCount": 0}

        # 3. Read current data from SQLite
        progress_holder[0] = 30
        parsed_data = data_service.get_data_from_db(old_entry_id)
        if not parsed_data:
            _logger.warning("SQLite data empty, trying data.json fallback")
            data_dir = Path(full_params_info.get("dirPath", ""))
            data_json_path = data_dir / "data.json"
            if data_json_path.exists():
                import json
                with open(data_json_path, "r", encoding="utf-8") as f:
                    parsed_data = json.load(f)
        
        if not parsed_data:
            return {"success": False, "message": "无法读取工参数据", "updatedCount": 0}

        # 4. Update PCI values in memory
        progress_holder[0] = 50
        updated_count = 0
        for network, sectors in parsed_data.items() if isinstance(parsed_data, dict) else [(network_type, parsed_data)]:
            if isinstance(sectors, list):
                for sector in sectors:
                    site_id = str(sector.get("siteId", "")).strip()
                    sector_id = str(sector.get("sectorId", "")).strip()
                    key = f"{site_id}_{sector_id}"
                    if key in pci_updates:
                        old_pci = sector.get("pci")
                        new_pci = pci_updates[key]
                        if old_pci != new_pci:
                            sector["pci"] = new_pci
                            updated_count += 1

        if updated_count == 0:
            return {"success": True, "message": "所有PCI值已是最新，无需更新", "updatedCount": 0}

        # 5. Generate new file ID and save to SQLite
        progress_holder[0] = 70
        import uuid
        new_data_id = str(uuid.uuid4())
        new_data_dir = data_service.data_dir / new_data_id
        new_data_dir.mkdir(parents=True, exist_ok=True)

        # Save parsed data as data.json in new directory
        import json
        with open(new_data_dir / "data.json", "w", encoding="utf-8") as f:
            json.dump(parsed_data, f, ensure_ascii=False, default=str)

        # Save to SQLite via data_service's helper
        new_file_name = full_params_info.get("fileName", "original.xlsx")
        new_file_name_updated = new_file_name.replace(".xlsx", f"_已更新PCI_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx")
        
        data_service._save_to_sqlite(
            workbook_id=new_data_id,
            workbook_name=new_file_name_updated,
            network_type=network_type,
            parsed_data=parsed_data,
            file_path=str(new_data_dir / "original.xlsx")  # placeholder, created in background
        )

        # 6. Update index: register new, mark old for cleanup
        progress_holder[0] = 85
        new_entry = {
            "fileType": "full_params",
            "fileName": new_file_name_updated,
            "dirPath": str(new_data_dir),
            "uploadTime": datetime.now().isoformat(),
            "networkType": network_type,
            "status": "sqlite_ready",  # New status: SQLite updated, Excel pending
            "originalEntryId": old_entry_id,
            "updatedCount": updated_count
        }
        data_service.index[new_data_id] = new_entry

        # Mark old entry as deprecated (don't delete files yet)
        if old_entry_id and old_entry_id in data_service.index:
            data_service.index[old_entry_id]["fileType"] = "full_params_deprecated"

        # Save index once
        data_service._save_index()

        progress_holder[0] = 100

        return {
            "success": True,
            "message": f"成功更新 {updated_count} 个小区的PCI值（SQLite已更新，Excel后台同步中）",
            "updatedCount": updated_count,
            "newFileId": new_data_id,
            "newFileName": new_file_name_updated,
            "oldEntryId": old_entry_id,
            "fullParamsInfo": full_params_info
        }

    except Exception as e:
        _logger.error(f"PCI apply fast path (SQLite only) failed: {e}", exc_info=True)
        return {"success": False, "message": f"PCI应用失败: {str(e)}", "updatedCount": 0}
```

**Step 3: Create new `_apply_pci_background_excel_update` method**

Extract the Excel update into a standalone background method:

```python
async def _apply_pci_background_excel_update(self, new_data_id: str, old_entry_id: str, 
                                               planning_result: Dict, full_params_info: Dict,
                                               _logger: logging.Logger) -> None:
    """Phase 2: Background Excel file update. User does not wait for this."""
    try:
        await asyncio.to_thread(
            self._sync_excel_update_only,
            new_data_id, old_entry_id, planning_result, full_params_info, _logger
        )
    except Exception as e:
        _logger.error(f"Background Excel update failed: {e}", exc_info=True)

def _sync_excel_update_only(self, new_data_id: str, old_entry_id: str,
                             planning_result: Dict, full_params_info: Dict,
                             _logger: logging.Logger) -> None:
    """Synchronous Excel-only update — runs in thread pool."""
    import openpyxl
    import shutil
    from pathlib import Path
    
    # 1. Copy original.xlsx to new directory
    new_data_dir = data_service.data_dir / new_data_id
    original_path = Path(full_params_info.get("dirPath", "")) / "original.xlsx"
    if original_path.exists():
        shutil.copy2(str(original_path), str(new_data_dir / "original.xlsx"))
    
    # 2. Build PCI update map (same as Phase 1)
    results = planning_result.get("results", [])
    network_type = planning_result.get("networkType", "LTE")
    pci_updates = {}
    for item in results:
        site_id = str(item.get("siteId", "")).strip()
        sector_id = str(item.get("sectorId", "")).strip()
        new_pci = item.get("suggestedPCI") or item.get("newPCI")
        if site_id and sector_id and new_pci is not None:
            key = f"{site_id}_{sector_id}"
            pci_updates[key] = int(new_pci)
    
    if not pci_updates:
        return
    
    # 3. Find source Excel (prefer original upload path)
    excel_path = new_data_dir / "original.xlsx"
    if not excel_path.exists():
        excel_path = Path(full_params_info.get("dirPath", "")) / "original.xlsx"
    if not excel_path.exists():
        _logger.warning(f"Excel file not found for background update: {excel_path}")
        return
    
    # 4. Load workbook and update PCI values
    try:
        wb = openpyxl.load_workbook(str(excel_path))
        sheet_name = "LTE" if network_type == "LTE" else "NR"
        if sheet_name not in wb.sheetnames:
            # Fallback: use first sheet
            sheet_name = wb.sheetnames[0] if wb.sheetnames else None
        if not sheet_name:
            wb.close()
            return
        
        ws = wb[sheet_name]
        headers = [str(cell.value or "").lower().strip() for cell in ws[1]]
        
        # Find column indices
        site_id_col_idx = None
        sector_id_col_idx = None
        pci_col_idx = None
        
        for i, h in enumerate(headers):
            if any(k in h for k in ["siteid", "站号", "站址编码", "站名"]):
                site_id_col_idx = i
            elif any(k in h for k in ["sectorid", "扇区号", "小区id", "小区号", "cellid"]):
                sector_id_col_idx = i
            elif any(k in h for k in ["pci", "物理小区标识", "物理小区id"]):
                pci_col_idx = i
        
        if site_id_col_idx is None or sector_id_col_idx is None or pci_col_idx is None:
            _logger.warning(f"Could not find required columns in Excel: site={site_id_col_idx}, sector={sector_id_col_idx}, pci={pci_col_idx}")
            wb.close()
            return
        
        # Update rows
        update_count = 0
        for row in ws.iter_rows(min_row=2, values_only=False):
            site_id = str(row[site_id_col_idx].value or "").strip()
            sector_id = str(row[sector_id_col_idx].value or "").strip()
            key = f"{site_id}_{sector_id}"
            if key in pci_updates:
                new_pci = pci_updates[key]
                if row[pci_col_idx].value != new_pci:
                    row[pci_col_idx].value = new_pci
                    update_count += 1
        
        wb.save(str(excel_path))
        wb.close()
        
        # 5. Update index status
        if new_data_id in data_service.index:
            data_service.index[new_data_id]["status"] = "completed"
            data_service._save_index()
        
        # 6. Clean up old deprecated entry files
        if old_entry_id and old_entry_id in data_service.index:
            old_dir = data_service.index[old_entry_id].get("dirPath")
            if old_dir and Path(old_dir).exists():
                import shutil
                try:
                    shutil.rmtree(old_dir)
                except Exception:
                    pass
            del data_service.index[old_entry_id]
            data_service._save_index()
        
        _logger.info(f"Background Excel update complete: {update_count} PCI values updated")
        
    except Exception as e:
        _logger.error(f"Excel background update failed: {e}", exc_info=True)
```

**Step 4: Modify `_run_apply_pci_to_params_task` to use the new split**

Replace the existing method body:

```python
async def _run_apply_pci_to_params_task(self, task: Task):
    _logger = logging.getLogger(__name__)
    _logger.info(f"[ApplyPCI] 开始处理任务 {task.task_id}")
    
    try:
        # --- Validate planning task ---
        planning_task_id = task.config.get("planningTaskId")
        if not planning_task_id:
            raise ValueError("缺少规划任务ID")
        
        self._tasks[planning_task_id]  # will raise KeyError if not found
        planning_task = self._tasks[planning_task_id]
        if not planning_task.result:
            raise ValueError("规划任务结果为空")
        
        planning_result = planning_task.result
        
        task.status = TaskStatus.PROCESSING
        task.progress = 5
        
        # ===== Phase 1: SQLite only (fast path) =====
        progress_holder = [10]
        result = await asyncio.to_thread(
            self._apply_pci_fast_sqlite_only,
            planning_result, progress_holder, _logger
        )
        
        if not result.get("success"):
            task.status = TaskStatus.FAILED
            task.error = result.get("message", "PCI应用失败")
            task.progress = 100
            task.end_time = datetime.now()
            self._persist_task(task.task_id)
            return
        
        task.result = result
        task.progress = 100
        task.status = TaskStatus.COMPLETED
        task.end_time = datetime.now()
        
        # Clear map cache
        from app.services.data_service import data_service
        data_service._map_data_cache = None
        data_service._map_data_cache_time = 0
        
        self._persist_task(task.task_id)
        self._save_task_result_to_db(task)
        
        _logger.info(f"[ApplyPCI] Phase 1 complete: {result.get('updatedCount')} cells updated (SQLite)")
        
        # ===== Phase 2: Background Excel update =====
        new_data_id = result.get("newFileId")
        old_entry_id = result.get("oldEntryId")
        full_params_info = result.get("fullParamsInfo")
        
        if new_data_id and old_entry_id and full_params_info:
            asyncio.create_task(
                self._apply_pci_background_excel_update(
                    new_data_id, old_entry_id, planning_result, full_params_info, _logger
                )
            )
        
    except KeyError:
        task.status = TaskStatus.FAILED
        task.error = "规划任务不存在或已过期"
        task.progress = 100
        task.end_time = datetime.now()
        self._persist_task(task.task_id)
        
    except Exception as e:
        _logger.error(f"[ApplyPCI] 任务执行失败: {e}", exc_info=True)
        task.status = TaskStatus.FAILED
        task.error = str(e)
        task.progress = 100
        task.end_time = datetime.now()
        self._persist_task(task.task_id)
```

**Step 5: Add missing import if needed**

Check that `from datetime import datetime` is present at the top of `task_manager.py`. It already should be based on the existing code.

**Step 6: Verify the changes compile**

Run: `cd /DATA/AppData/NetworkPlanningTooV3/backend && python -c "from app.services.task_manager import task_manager; print('Import OK')"`
Expected: `Import OK`

**Step 7: Commit**

```bash
git add backend/app/services/task_manager.py
git commit -m "perf: split PCI apply into SQLite fast path + background Excel update

- Phase 1: SQLite-only update, no Excel I/O, target < 2s
- Phase 2: Background thread for openpyxl Excel update
- Batch index operations instead of per-entry delete_data()
- Deprecated old entries instead of immediate file deletion

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1.2: Adjust PCI apply API endpoint return timing

**Files:**
- Modify: `backend/app/api/v1/endpoints/pci.py:135-154`

**Step 1: Read current endpoint**

Read lines 135-154 of `pci.py`.

**Step 2: Handle the case where the apply task completes quickly**

The current endpoint calls `create_apply_pci_to_params_task` which returns an `apply_task_id`. The frontend then has to poll for progress. Since Phase 1 now completes in <2s, we can make the endpoint optionally wait for Phase 1 completion.

Modify the response to include whether Phase 1 is already complete:

```python
@router.post("/apply-to-params/{task_id}", response_model=Dict[str, Any])
async def apply_pci_to_params(task_id: str) -> Dict[str, Any]:
    """Apply PCI planning results to parameters.
    Phase 1 (SQLite) completes in ~1-2s.
    Phase 2 (Excel update) runs in background.
    """
    try:
        apply_task_id = await task_manager.create_apply_pci_to_params_task(task_id)
        
        # Give Phase 1 a moment to complete (max 5s wait)
        import asyncio
        for _ in range(25):  # 25 * 0.2s = 5s max wait
            await asyncio.sleep(0.2)
            progress = task_manager.get_task_progress(apply_task_id)
            if progress and progress.get("status") in ("completed", "failed"):
                result = task_manager.get_task_result(apply_task_id)
                return {
                    "success": True,
                    "data": {
                        "taskId": apply_task_id,
                        "result": result,
                        "message": result.get("message", "PCI应用完成") if result else "PCI应用完成"
                    }
                }
        
        # Phase 1 not complete yet — return taskId for polling
        return {
            "success": True,
            "data": {
                "taskId": apply_task_id,
                "message": "PCI应用到工参任务已启动，SQLite更新中..."
            }
        }
    except ValueError as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=400, detail=safe_detail)
    except Exception as e:
        safe_detail = str(e).encode("gbk", "replace").decode("gbk")
        raise HTTPException(status_code=500, detail=safe_detail)
```

**Step 3: Verify**

Run: `cd /DATA/AppData/NetworkPlanningTooV3/backend && python -c "from app.api.v1.endpoints.pci import router; print('Import OK')"`
Expected: `Import OK`

**Step 4: Commit**

```bash
git add backend/app/api/v1/endpoints/pci.py
git commit -m "perf: PCI apply endpoint waits briefly for Phase 1 completion

- Short-poll Phase 1 for up to 5 seconds before falling back to taskId
- Returns result inline when Phase 1 completes quickly

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1.3: Update frontend PCI apply handler

**Files:**
- Modify: `frontend/src/renderer/pages/PCIPage.tsx:814-854`

**Step 1: Read the current handler**

Read lines 814-854 of `PCIPage.tsx`.

**Step 2: Simplify `handleApplyToParams` for the new fast path**

The endpoint now returns the result inline (when Phase 1 completes in <5s). Simplify the handler:

```typescript
const handleApplyToParams = useCallback(async () => {
    const applyTaskId = taskId || currentTaskResult?.taskId
    if (!applyTaskId) return
    
    setApplyingToParams(true)
    setApplySuccess(false)
    
    try {
        const response = await pciApi.applyToParams(applyTaskId)
        if (response?.success) {
            // The backend may return result inline (Phase 1 completed)
            // or just a taskId to poll
            const data = response.data
            if (data?.result?.updatedCount !== undefined) {
                setApplySuccess(true)
                setMessage?.({ type: 'success', text: `成功更新 ${data.result.updatedCount} 个小区PCI值` })
            } else if (data?.taskId) {
                // Fallback: poll for result
                const pollResult = await pollApplyResult(data.taskId)
                if (pollResult?.updatedCount !== undefined) {
                    setApplySuccess(true)
                    setMessage?.({ type: 'success', text: `成功更新 ${pollResult.updatedCount} 个小区PCI值` })
                }
            }
            
            // Refresh data
            triggerDataRefresh()
            if (mapRef.current?.clearCache) {
                mapRef.current.clearCache()
            }
        }
    } catch (err) {
        setMessage?.({ type: 'error', text: `应用失败: ${err}` })
    } finally {
        setApplyingToParams(false)
    }
}, [taskId, currentTaskResult, triggerDataRefresh, mapRef, setMessage])
```

Also update `handleApplyTask` (lines 293-336) similarly:

```typescript
const handleApplyTask = useCallback(async (task: { id: string }): Promise<boolean> => {
    setApplyingToParams(true)
    setApplySuccess(false)
    
    try {
        const response = await pciApi.applyToParams(task.id)
        if (response?.success) {
            const data = response.data
            let updatedCount: number | undefined
            
            if (data?.result?.updatedCount !== undefined) {
                updatedCount = data.result.updatedCount
            } else if (data?.taskId) {
                const pollResult = await pollApplyResult(data.taskId)
                updatedCount = pollResult?.updatedCount
            }
            
            if (updatedCount !== undefined) {
                setApplySuccess(true)
                setMessage?.({ type: 'success', text: `成功更新 ${updatedCount} 个小区PCI值` })
            }
            
            // Mark task as applied
            await pciApi.markApplied(task.id)
            
            // Refresh data
            mapDataService?.clearCache?.()
            triggerDataRefresh()
            
            return true
        }
        return false
    } catch (err) {
        setMessage?.({ type: 'error', text: `应用失败: ${err}` })
        return false
    } finally {
        setApplyingToParams(false)
    }
}, [triggerDataRefresh, mapRef, setMessage])
```

Add the `pollApplyResult` helper:

```typescript
const pollApplyResult = useCallback(async (applyTaskId: string, timeout = 30000): Promise<any> => {
    const startTime = Date.now()
    const poll = async (): Promise<any> => {
        try {
            const progressResp = await pciApi.getApplyProgress(applyTaskId)
            if (progressResp?.status === 'completed') {
                const resultResp = await pciApi.getApplyResult(applyTaskId)
                return resultResp
            }
            if (progressResp?.status === 'failed') {
                throw new Error(progressResp.error || 'PCI应用失败')
            }
        } catch (e) {
            if (Date.now() - startTime > timeout) throw e
        }
        
        if (Date.now() - startTime > timeout) {
            // Return apply_task_id so frontend can poll independently
            return { applyTaskId }
        }
        
        await new Promise(r => setTimeout(r, 1000))
        return poll()
    }
    return poll()
}, [])
```

**Step 3: Commit**

```bash
git add frontend/src/renderer/pages/PCIPage.tsx
git commit -m "perf: update PCI apply handler for fast SQLite path

- Handle inline result from Phase 1 completion
- Fallback to polling if Phase 1 takes >5s
- Reduce poll timeout from 600s to 30s

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Stage 2: Map Search Marker Style (P1)

### Task 2.1: Change search marker divIcon from teardrop to red circle

**Files:**
- Modify: `frontend/src/renderer/components/Map/OnlineMap.tsx:602-633`

**Step 1: Read the current `setSearchMarker` method**

Read lines 602-633 of `OnlineMap.tsx`.

**Step 2: Modify the `divIcon` html and size**

Change the marker icon from teardrop to red circle:

```typescript
// Find this code block (around lines 609-618):
const icon = L.divIcon({
    html: `<div style="background-color: #ef4444; width: 24px; height: 24px; 
           border-radius: 50% 50% 50% 0; transform: rotate(-45deg); 
           border: 3px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.3);"></div>`,
    className: 'search-marker-icon',
    iconSize: [24, 24],
    iconAnchor: [12, 24]
})

// Replace with:
const icon = L.divIcon({
    html: `<div style="background-color: #ef4444; width: 16px; height: 16px; 
           border-radius: 50%; border: 2px solid white; 
           box-shadow: 0 2px 6px rgba(0,0,0,0.3);"></div>`,
    className: 'search-marker-icon',
    iconSize: [16, 16],
    iconAnchor: [8, 8]
})
```

**Step 3: Commit**

```bash
git add frontend/src/renderer/components/Map/OnlineMap.tsx
git commit -m "style: change search marker from teardrop to red circle

- 16px red circle matching capture-marker style
- Less visual obstruction of map elements

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Stage 3: Task State Persistence & Global Indicator (P2)

### Task 3.1: Create `pciStore.ts` — PCI planning state store

**Files:**
- Create: `frontend/src/renderer/store/pciStore.ts`

**Step 1: Create the store**

```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type WizardStep = 'idle' | 'task_created' | 'params_set' | 'cells_selected' | 'executing' | 'completed'
type LeftTab = 'history' | 'task-config' | 'planning-result'

interface PCIConfig {
  networkType: string
  distanceThreshold: number
  inheritModulus: boolean
  useMod3: boolean
  useMod30: boolean
  pciRange: string
  enableTACPlanning: boolean
}

interface PCIState {
  // State fields
  wizardStep: WizardStep
  config: PCIConfig
  selectedCellIds: string[]
  activeLeftTab: LeftTab
  taskName: string
  
  // Actions
  setWizardStep: (step: WizardStep) => void
  setConfig: (config: Partial<PCIConfig>) => void
  setSelectedCellIds: (ids: string[]) => void
  setActiveLeftTab: (tab: LeftTab) => void
  setTaskName: (name: string) => void
  resetConfig: () => void
}

const defaultConfig: PCIConfig = {
  networkType: 'LTE',
  distanceThreshold: 10.0,
  inheritModulus: false,
  useMod3: true,
  useMod30: false,
  pciRange: '0-503',
  enableTACPlanning: true
}

export const usePCIStore = create<PCIState>()(
  persist(
    (set) => ({
      wizardStep: 'idle',
      config: { ...defaultConfig },
      selectedCellIds: [],
      activeLeftTab: 'history',
      taskName: '',
      
      setWizardStep: (step) => set({ wizardStep: step }),
      setConfig: (partial) => set((state) => ({ config: { ...state.config, ...partial } })),
      setSelectedCellIds: (ids) => set({ selectedCellIds: ids }),
      setActiveLeftTab: (tab) => set({ activeLeftTab: tab }),
      setTaskName: (name) => set({ taskName: name }),
      resetConfig: () => set({
        wizardStep: 'idle',
        config: { ...defaultConfig },
        selectedCellIds: [],
        taskName: ''
      })
    }),
    {
      name: 'pci-planning-storage',
      partialize: (state) => ({
        wizardStep: state.wizardStep,
        config: state.config,
        selectedCellIds: state.selectedCellIds,
        activeLeftTab: state.activeLeftTab,
        taskName: state.taskName
      })
    }
  )
)
```

**Step 2: Commit**

```bash
git add frontend/src/renderer/store/pciStore.ts
git commit -m "feat: create PCI planning Zustand store with persist

- Persists wizardStep, config, selectedCellIds, activeLeftTab, taskName
- Enables state recovery across page navigation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.2: Create `neighborStore.ts` — Neighbor planning state store

**Files:**
- Create: `frontend/src/renderer/store/neighborStore.ts`

**Step 1: Create the store**

```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type WizardStep = 'idle' | 'task_created' | 'params_set' | 'cells_selected' | 'executing' | 'completed'
type LeftTab = 'history' | 'task-config' | 'planning-result'

interface NeighborConfig {
  planningType: string
  maxNeighbors: number
  coverageDistanceFactor: number
  coverageRadiusFactor: number
}

interface NeighborState {
  wizardStep: WizardStep
  config: NeighborConfig
  selectedCellIds: string[]
  activeLeftTab: LeftTab
  taskName: string
  
  setWizardStep: (step: WizardStep) => void
  setConfig: (config: Partial<NeighborConfig>) => void
  setSelectedCellIds: (ids: string[]) => void
  setActiveLeftTab: (tab: LeftTab) => void
  setTaskName: (name: string) => void
  resetConfig: () => void
}

const defaultConfig: NeighborConfig = {
  planningType: 'LTE-LTE',
  maxNeighbors: 64,
  coverageDistanceFactor: 1.0,
  coverageRadiusFactor: 1.0
}

export const useNeighborStore = create<NeighborState>()(
  persist(
    (set) => ({
      wizardStep: 'idle',
      config: { ...defaultConfig },
      selectedCellIds: [],
      activeLeftTab: 'history',
      taskName: '',
      
      setWizardStep: (step) => set({ wizardStep: step }),
      setConfig: (partial) => set((state) => ({ config: { ...state.config, ...partial } })),
      setSelectedCellIds: (ids) => set({ selectedCellIds: ids }),
      setActiveLeftTab: (tab) => set({ activeLeftTab: tab }),
      setTaskName: (name) => set({ taskName: name }),
      resetConfig: () => set({
        wizardStep: 'idle',
        config: { ...defaultConfig },
        selectedCellIds: [],
        taskName: ''
      })
    }),
    {
      name: 'neighbor-planning-storage',
      partialize: (state) => ({
        wizardStep: state.wizardStep,
        config: state.config,
        selectedCellIds: state.selectedCellIds,
        activeLeftTab: state.activeLeftTab,
        taskName: state.taskName
      })
    }
  )
)
```

**Step 2: Commit**

```bash
git add frontend/src/renderer/store/neighborStore.ts
git commit -m "feat: create neighbor planning Zustand store with persist

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.3: Create/extend `tacCheckStore.ts` — TAC check state store

**Files:**
- Create: `frontend/src/renderer/store/tacCheckStore.ts`

**Step 1: Create the store (replaces tacStore.ts)**

```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type WizardStep = 'idle' | 'task_created' | 'params_set' | 'cells_selected' | 'executing' | 'completed'
type LeftTab = 'history' | 'task-config' | 'planning-result'

interface TACCheckConfig {
  networkType: 'LTE' | 'NR'
}

interface TACCheckState {
  wizardStep: WizardStep
  config: TACCheckConfig
  selectedCellIds: string[]
  activeLeftTab: LeftTab
  taskName: string
  
  setWizardStep: (step: WizardStep) => void
  setConfig: (config: Partial<TACCheckConfig>) => void
  setSelectedCellIds: (ids: string[]) => void
  setActiveLeftTab: (tab: LeftTab) => void
  setTaskName: (name: string) => void
  resetConfig: () => void
}

export const useTACCheckStore = create<TACCheckState>()(
  persist(
    (set) => ({
      wizardStep: 'idle',
      config: { networkType: 'LTE' },
      selectedCellIds: [],
      activeLeftTab: 'history',
      taskName: '',
      
      setWizardStep: (step) => set({ wizardStep: step }),
      setConfig: (partial) => set((state) => ({ config: { ...state.config, ...partial } })),
      setSelectedCellIds: (ids) => set({ selectedCellIds: ids }),
      setActiveLeftTab: (tab) => set({ activeLeftTab: tab }),
      setTaskName: (name) => set({ taskName: name }),
      resetConfig: () => set({
        wizardStep: 'idle',
        config: { networkType: 'LTE' },
        selectedCellIds: [],
        taskName: ''
      })
    }),
    {
      name: 'tac-check-storage',
      partialize: (state) => ({
        wizardStep: state.wizardStep,
        config: state.config,
        selectedCellIds: state.selectedCellIds,
        activeLeftTab: state.activeLeftTab,
        taskName: state.taskName
      })
    }
  )
)
```

**Step 2: Mark `tacStore.ts` as deprecated** (add comment at top)

Update `tacStore.ts`:

```typescript
// @deprecated Use tacCheckStore.ts instead. Kept for backward compatibility.
// TAC check configuration storage (only persists network type preference).
...
```

**Step 3: Commit**

```bash
git add frontend/src/renderer/store/tacCheckStore.ts
git add frontend/src/renderer/store/tacStore.ts
git commit -m "feat: create TAC check Zustand store with persist

- Extends old tacStore with full wizard state persistence
- Marks old tacStore as deprecated

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.4: Update `tacPlanningStore.ts` — Add `activeLeftTab` field

**Files:**
- Modify: `frontend/src/renderer/store/tacPlanningStore.ts`

**Step 1: Read the current store**

Read the full `tacPlanningStore.ts`.

**Step 2: Add `activeLeftTab` field**

Add to the interface and store:

```typescript
// In TACPlanningState interface, add:
interface TACPlanningState {
  taskId: string | null
  config: { networkType: 'LTE' | 'NR' } | null
  result: any | null
  activeLeftTab: 'history' | 'task-config' | 'planning-result'  // ADD
  // ... existing methods
  
  setActiveLeftTab: (tab: 'history' | 'task-config' | 'planning-result') => void  // ADD
  // ... rest unchanged
}
```

Add implementation:

```typescript
// In the store creation:
activeLeftTab: 'history',  // ADD after result: null

setActiveLeftTab: (tab) => set({ activeLeftTab: tab }),  // ADD as new action

// In partialize, add:
partialize: (state) => ({
  taskId: state.taskId,
  config: state.config,
  result: state.result,
  activeLeftTab: state.activeLeftTab,  // ADD
})
```

**Step 3: Commit**

```bash
git add frontend/src/renderer/store/tacPlanningStore.ts
git commit -m "feat: add activeLeftTab to tacPlanningStore

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.5: Create `GlobalTaskIndicator.tsx` component

**Files:**
- Create: `frontend/src/renderer/components/Layout/GlobalTaskIndicator.tsx`

**Step 1: Create the component**

```tsx
import React from 'react'
import { useTaskStore } from '../../store/taskStore'
import { useNavigate } from 'react-router-dom'

// Task type to route mapping
const TASK_ROUTES: Record<string, string> = {
  pci_planning: '/pci',
  neighbor_planning: '/neighbor',
  tac_check: '/tac',
  tac_planning: '/tac/planning'
}

// Task type to display name mapping
const TASK_LABELS: Record<string, string> = {
  pci_planning: 'PCI规划',
  neighbor_planning: '邻区规划',
  tac_check: 'TAC核查',
  tac_planning: 'TAC规划'
}

export const GlobalTaskIndicator: React.FC = () => {
  const tasks = useTaskStore(s => s.tasks)
  const activeTaskIds = useTaskStore(s => s.activeTaskIds)
  const navigate = useNavigate()

  // Find any running tasks
  const runningEntries = React.useMemo(() => {
    const entries: Array<{ type: string; taskId: string; progress: number; label: string }> = []
    
    for (const [type, taskId] of Object.entries(activeTaskIds)) {
      if (!taskId) continue
      const task = tasks[taskId]
      if (!task) continue
      if (task.status === 'running' || task.status === 'pending' || task.status === 'processing') {
        entries.push({
          type,
          taskId,
          progress: task.progress ?? 0,
          label: TASK_LABELS[type] || type
        })
      }
    }
    
    return entries
  }, [tasks, activeTaskIds])

  if (runningEntries.length === 0) return null

  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex justify-center pointer-events-none">
      <div className="flex gap-3 mt-1 pointer-events-auto">
        {runningEntries.map(entry => (
          <button
            key={entry.taskId}
            onClick={() => {
              const route = TASK_ROUTES[entry.type]
              if (route) navigate(route)
            }}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium
                       bg-primary/10 text-primary rounded-full border border-primary/20
                       hover:bg-primary/20 transition-colors shadow-sm"
            title="点击跳转到任务页面"
          >
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            <span>{entry.label}: {Math.round(entry.progress)}%</span>
          </button>
        ))}
      </div>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add frontend/src/renderer/components/Layout/GlobalTaskIndicator.tsx
git commit -m "feat: add GlobalTaskIndicator component

- Shows running tasks as floating badges at top of screen
- Displays progress percentage with pulse animation
- Click to navigate to the task's page
- Auto-hides when no tasks are running

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.6: Integrate `GlobalTaskIndicator` into `MainLayout.tsx`

**Files:**
- Modify: `frontend/src/renderer/components/Layout/MainLayout.tsx`

**Step 1: Read the current MainLayout**

Read lines around the `<main>` element.

**Step 2: Add GlobalTaskIndicator before children**

```tsx
// At the top of the file, add import:
import { GlobalTaskIndicator } from './GlobalTaskIndicator'

// Inside the main content area, before {children}:
<main className="flex-1 overflow-auto flex flex-col relative z-10">
  <GlobalTaskIndicator />  {/* ADD THIS LINE */}
  {children}
</main>
```

**Step 3: Commit**

```bash
git add frontend/src/renderer/components/Layout/MainLayout.tsx
git commit -m "feat: integrate GlobalTaskIndicator into MainLayout

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.7: Update `PCIPage.tsx` to use `usePCIStore`

**Files:**
- Modify: `frontend/src/renderer/pages/PCIPage.tsx`

**Step 1: Replace useState imports with store**

```typescript
// Add import at top:
import { usePCIStore } from '../store/pciStore'

// Replace these useState declarations (around lines 130-142):
const [config, setConfig] = useState({ ... })
const [taskName, setTaskName] = useState('')
const [wizardStep, setWizardStep] = useState('idle')
const [activeLeftTab, setActiveLeftTab] = useState('history')
const [selectedCellIds, setSelectedCellIds] = useState(new Set<string>())

// With:
const { 
  wizardStep, setWizardStep, 
  config, setConfig, 
  selectedCellIds, setSelectedCellIds,
  activeLeftTab, setActiveLeftTab,
  taskName, setTaskName,
  resetConfig
} = usePCIStore()

// Note: selectedCellIds needs special handling since store uses string[] and page uses Set<string>
// Add a local bridge state:
const [selectedCellIdsSet, setSelectedCellIdsSet] = useState<Set<string>>(
  new Set(selectedCellIds)
)

// Sync from store on mount
useEffect(() => {
  setSelectedCellIdsSet(new Set(selectedCellIds))
}, [selectedCellIds])

// Sync to store on change
const handleToggleCell = (id: string) => {
  const next = new Set(selectedCellIdsSet)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  setSelectedCellIdsSet(next)
  setSelectedCellIds(Array.from(next))
}
```

**Step 2: Replace `resetConfig` usage**

Replace standalone `resetConfig` function (likely around line 196-208 or similar) with `usePCIStore().resetConfig()`:

```typescript
// Remove the local resetConfig function, replace calls to it with:
resetConfig()
```

**Step 3: Handle `handleNext` / `handleBack` transitions**

The existing `setWizardStep('idle')` etc. calls stay the same since we're now using the store's `setWizardStep`.

**Step 4: Handle activeLeftTab changes**

Replace `setActiveLeftTab('history')` with the store's `setActiveLeftTab('history')` — same API.

**Step 5: Adjust tabs that depend on `activeLeftTab === 'task-config'`**

The useEffects that watch `activeLeftTab` still work the same way.

**Step 6: Commit**

```bash
git add frontend/src/renderer/pages/PCIPage.tsx
git commit -m "refactor: PCIPage uses usePCIStore for state persistence

- Replaces useState for wizardStep, config, selectedCellIds, activeLeftTab, taskName
- Handles Set<string> <-> string[] conversion for selectedCellIds
- Enables state recovery across page navigation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.8: Update `NeighborPage.tsx` to use `useNeighborStore`

**Files:**
- Modify: `frontend/src/renderer/pages/NeighborPage.tsx`

Same pattern as Task 3.7. Replace local useState with `useNeighborStore`.

**Step 1: Replace useState with store**

```typescript
// Add import:
import { useNeighborStore } from '../store/neighborStore'

// Replace state declarations:
const {
  wizardStep, setWizardStep,
  config, setConfig,
  selectedCellIds, setSelectedCellIds,
  activeLeftTab, setActiveLeftTab,
  taskName, setTaskName,
  resetConfig
} = useNeighborStore()

// Bridge for selectedCellIds Set<->string[]
const [selectedCellIdsSet, setSelectedCellIdsSet] = useState<Set<string>>(
  new Set(selectedCellIds)
)
useEffect(() => { setSelectedCellIdsSet(new Set(selectedCellIds)) }, [selectedCellIds])
```

**Step 2: Commit**

```bash
git add frontend/src/renderer/pages/NeighborPage.tsx
git commit -m "refactor: NeighborPage uses useNeighborStore for state persistence

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.9: Update `TACPage.tsx` to use `useTACCheckStore`

**Files:**
- Modify: `frontend/src/renderer/pages/TACPage.tsx`

**Step 1: Replace `useTACStore` with `useTACCheckStore`**

```typescript
// Change import:
// import { useTACStore } from '../store/tacStore'  // OLD
import { useTACCheckStore } from '../store/tacCheckStore'  // NEW

// Replace:
// const { config, setConfig } = useTACStore()
const {
  wizardStep, setWizardStep,
  config, setConfig,
  selectedCellIds, setSelectedCellIds,
  activeLeftTab, setActiveLeftTab,
  taskName, setTaskName,
  resetConfig
} = useTACCheckStore()
```

**Step 2: Replace local state declarations**

Remove the local `wizardStep`, `config` (partially), `activeLeftTab`, `taskName` useState declarations and replace with the store as above.

**Step 3: Handle selectedCellIds Set conversion**

Same bridge pattern as Task 3.7.

**Step 4: Commit**

```bash
git add frontend/src/renderer/pages/TACPage.tsx
git commit -m "refactor: TACPage uses useTACCheckStore for state persistence

- Replaces useTACStore with useTACCheckStore (backward compatible)
- Adds full wizard state persistence

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.10: Update `TACPlanningPage.tsx` — sync activeLeftTab with store

**Files:**
- Modify: `frontend/src/renderer/pages/TACPlanningPage.tsx`

**Step 1: Add activeLeftTab to store usage**

```typescript
// In the useTACPlanningStore destructuring, add:
const { 
  taskId, config, result, 
  setTaskId, setConfig, setResult, clearTAC,
  activeLeftTab, setActiveLeftTab  // ADD
} = useTACPlanningStore()

// Remove the local useState for activeLeftTab:
// const [activeLeftTab, setActiveLeftTab] = useState<'history' | 'task-config' | 'planning-result'>('history')
```

**Step 2: Commit**

```bash
git add frontend/src/renderer/pages/TACPlanningPage.tsx
git commit -m "refactor: TACPlanningPage syncs activeLeftTab with tacPlanningStore

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.11: Build and verify frontend

**Step 1: Build the frontend**

```bash
cd /DATA/AppData/NetworkPlanningTooV3/frontend
npm run build:vite 2>&1
```

Expected: Build succeeds with no errors.

**Step 2: Fix any TypeScript compilation errors**

If there are type errors, fix them one by one.

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve TypeScript errors from store migration"
```

---

## Verify Complete Implementation

### Backend test

```bash
cd /DATA/AppData/NetworkPlanningTooV3/backend
python -c "
from app.services.task_manager import task_manager
print('task_manager imported OK')
# Check new methods exist
assert hasattr(task_manager, '_apply_pci_fast_sqlite_only'), 'Missing _apply_pci_fast_sqlite_only'
assert hasattr(task_manager, '_apply_pci_background_excel_update'), 'Missing _apply_pci_background_excel_update'
print('New methods verified OK')
"
```

### Frontend build

```bash
cd /DATA/AppData/NetworkPlanningTooV3/frontend
npm run type-check 2>&1 || npm run build:vite 2>&1
```

Expected: No type errors.
