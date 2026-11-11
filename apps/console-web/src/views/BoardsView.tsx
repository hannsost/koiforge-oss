import { useEffect, useState } from 'react';

import { fetchBoardSuggestions, type ExplorerLinkSuggestion, type SavedViewRecord } from '../api';
import { BoardViewer, type BoardEdge, type BoardGrouping, type BoardNode } from '../components/BoardViewer';
import {
  Badge,
  Card,
  confidenceTone,
  ghostBtnCls,
  inputCls,
  saveViewBtnCls,
  viewChipCls,
} from '../components/ui';

interface BoardsViewProps {
  boardViewName: string;
  onBoardViewNameChange: (value: string) => void;
  onSaveBoardView: () => void;
  boardViews: SavedViewRecord[];
  onApplyBoardView: (view: SavedViewRecord) => void;
  boardGroupBy: BoardGrouping;
  onBoardGroupByChange: (value: BoardGrouping) => void;
  onApplyBoardSuggestion: (suggestion: ExplorerLinkSuggestion) => void;
  boardEdges: BoardEdge[];
  boardNodes: BoardNode[];
  linkSourceNodeId: string | null;
  onChangeBoardEdges: (edges: BoardEdge[]) => void;
  onChangeBoardNodes: (nodes: BoardNode[]) => void;
  onChangeLinkSource: (nodeId: string | null) => void;
}

export function BoardsView(props: BoardsViewProps) {
  const [boardSuggestions, setBoardSuggestions] = useState<ExplorerLinkSuggestion[]>([]);

  useEffect(() => {
    fetchBoardSuggestions().then(setBoardSuggestions).catch(console.error);
  }, []);

  return (
    <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
      {/* Controls */}
      <Card title="Board Controls">
        <div className="space-y-4">
          {/* Save view */}
          <div>
            <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[#3a4e6a]">Save view</div>
            <div className="flex gap-2">
              <input
                className={`${inputCls} min-w-0 flex-1`}
                placeholder="View name…"
                value={props.boardViewName}
                onChange={(e) => props.onBoardViewNameChange(e.target.value)}
              />
              <button data-testid="save-board-view" className={saveViewBtnCls} onClick={props.onSaveBoardView} type="button">Save</button>
            </div>
          </div>

          {/* Saved views */}
          {props.boardViews.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[#3a4e6a]">Saved views</div>
              <div className="flex flex-wrap gap-1.5">
                {props.boardViews.map((view) => (
                  <button data-testid={`board-view-${view.id}`} key={view.id} className={viewChipCls} onClick={() => props.onApplyBoardView(view)} type="button">
                    {view.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Grouping */}
          <div>
            <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[#3a4e6a]">Grouping</div>
            <div className="flex gap-1">
              {(['none', 'type', 'status'] as BoardGrouping[]).map((mode) => (
                <button
                  data-testid={`board-group-${mode}`}
                  key={mode}
                  className={`rounded px-3 py-1.5 text-[12px] font-medium transition ${props.boardGroupBy === mode ? 'bg-brand text-white' : 'border border-rim text-[#6b82a0] hover:border-dim hover:text-white'}`}
                  onClick={() => props.onBoardGroupByChange(mode)}
                  type="button"
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* Suggestions */}
          <div>
            <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[#3a4e6a]">Link suggestions</div>
            <div className="space-y-1.5">
              {boardSuggestions.slice(0, 6).map((s) => (
                <button
                  key={`${s.fromId}-${s.toId}`}
                  className="w-full rounded border border-rim bg-ink/50 px-3 py-2 text-left transition hover:border-brand-border"
                  onClick={() => props.onApplyBoardSuggestion(s)}
                  type="button"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-[12px] text-[#c8d6ef]">
                      {s.fromId} <span className="text-[#2e415a]">→</span> {s.toId}
                    </div>
                    <Badge tone={confidenceTone(s.confidenceLabel)}>{s.confidence.toFixed(2)}</Badge>
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-[#2e415a]">{s.reasons.join(', ')}</div>
                </button>
              ))}
              {boardSuggestions.length === 0 && (
                <div className="text-[12px] text-[#2e415a]">No suggestions. Add objects from the Object Explorer.</div>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Canvas */}
      <Card
        title="Board"
        action={props.linkSourceNodeId
          ? <Badge tone="warning">Source selected</Badge>
          : <Badge tone="neutral">Drag · Link · Group</Badge>
        }
      >
        <BoardViewer
          edges={props.boardEdges}
          groupBy={props.boardGroupBy}
          linkSourceNodeId={props.linkSourceNodeId}
          nodes={props.boardNodes}
          onChangeEdges={props.onChangeBoardEdges}
          onChangeLinkSource={props.onChangeLinkSource}
          onChangeNodes={props.onChangeBoardNodes}
        />
      </Card>
    </div>
  );
}
