import { useEffect, useRef, useState } from 'react';
import { UiIcon } from './ProductIdentity';

export interface BoardNode {
  id: string;
  objectId: string;
  objectType: string;
  title: string;
  subtitle?: string;
  status?: string;
  accentTone?: 'neutral' | 'success' | 'warning' | 'danger';
  x: number;
  y: number;
}

export type BoardGrouping = 'none' | 'type' | 'status';

const statusOrder = ['pending', 'review', 'active', 'approved', 'shipped', 'delayed', 'watchlist', 'unassigned'];

function toneForStatus(status: string | undefined): BoardNode['accentTone'] {
  if (!status) return 'neutral';
  if (status === 'delayed' || status === 'watchlist') return 'danger';
  if (status === 'review' || status === 'pending') return 'warning';
  if (status === 'active' || status === 'approved' || status === 'shipped') return 'success';
  return 'neutral';
}

export interface BoardEdge {
  id: string;
  fromId: string;
  toId: string;
}

const toneColors: Record<NonNullable<BoardNode['accentTone']>, { border: string; bg: string; dot: string }> = {
  success: { border: 'rgba(34,197,94,0.35)',  bg: 'rgba(34,197,94,0.06)',  dot: '#22c55e' },
  warning: { border: 'rgba(245,158,11,0.35)', bg: 'rgba(245,158,11,0.06)', dot: '#f59e0b' },
  danger:  { border: 'rgba(239,68,68,0.35)',  bg: 'rgba(239,68,68,0.06)',  dot: '#ef4444' },
  neutral: { border: '#1a2640',               bg: 'rgba(12,18,33,0.80)',   dot: '#4F79E7' },
};

interface BoardViewerProps {
  edges: BoardEdge[];
  groupBy: BoardGrouping;
  linkSourceNodeId: string | null;
  nodes: BoardNode[];
  onChangeEdges: (edges: BoardEdge[]) => void;
  onChangeNodes: (nodes: BoardNode[]) => void;
  onChangeLinkSource: (nodeId: string | null) => void;
}

export function BoardViewer(props: BoardViewerProps) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [dragState, setDragState] = useState<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);

  useEffect(() => {
    if (!dragState) return;

    const handleMove = (event: PointerEvent) => {
      const board = boardRef.current;
      if (!board) return;
      const rect = board.getBoundingClientRect();
      props.onChangeNodes(props.nodes.map((node) =>
        node.id === dragState.nodeId
          ? { ...node, x: Math.max(0, Math.min(event.clientX - rect.left - dragState.offsetX, rect.width - 176)), y: Math.max(0, Math.min(event.clientY - rect.top - dragState.offsetY, rect.height - 96)) }
          : node,
      ));
    };

    const handleUp = () => {
      if (dragState && props.groupBy !== 'none') {
        const board = boardRef.current;
        const activeNode = props.nodes.find((n) => n.id === dragState.nodeId);
        if (board && activeNode) {
          const laneLabels = props.groupBy === 'type'
            ? [...new Set(props.nodes.map((n) => n.objectType))].sort()
            : [...new Set(props.nodes.map((n) => n.status ?? 'unassigned'))].sort((a, b) => statusOrder.indexOf(a) - statusOrder.indexOf(b));
          const segment = board.clientWidth / Math.max(laneLabels.length, 1);
          const laneIndex = Math.max(0, Math.min(laneLabels.length - 1, Math.floor(activeNode.x / Math.max(segment, 1))));
          const targetLane = laneLabels[laneIndex];
          if (targetLane) {
            props.onChangeNodes(props.nodes.map((node) => {
              if (node.id !== dragState.nodeId) return node;
              if (props.groupBy === 'type') return { ...node, objectType: targetLane };
              return { ...node, status: targetLane, accentTone: toneForStatus(targetLane) };
            }));
          }
        }
      }
      setDragState(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => { window.removeEventListener('pointermove', handleMove); window.removeEventListener('pointerup', handleUp); };
  }, [dragState, props]);

  const laneLabels = (() => {
    if (props.groupBy === 'none') return [] as string[];
    if (props.groupBy === 'type') return [...new Set(props.nodes.map((n) => n.objectType))].sort();
    return [...new Set(props.nodes.map((n) => n.status ?? 'unassigned'))].sort((a, b) => statusOrder.indexOf(a) - statusOrder.indexOf(b));
  })();

  function laneForNode(node: BoardNode): string {
    if (props.groupBy === 'type') return node.objectType;
    if (props.groupBy === 'status') return node.status ?? 'unassigned';
    return '';
  }

  function displayLeft(node: BoardNode): number {
    if (props.groupBy === 'none') return node.x;
    const laneIndex = Math.max(laneLabels.indexOf(laneForNode(node)), 0);
    const width = boardRef.current?.clientWidth ?? 800;
    return laneIndex * (width / Math.max(laneLabels.length, 1)) + 16;
  }

  return (
    <div ref={boardRef} data-testid="board-canvas" className="relative h-[520px] overflow-hidden rounded border border-rim bg-ink/70">
      {/* Lane headers */}
      {laneLabels.length > 0 && (
        <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${laneLabels.length}, minmax(0, 1fr))` }}>
          {laneLabels.map((label) => (
            <div key={label} className="border-r border-rim/50 last:border-r-0">
              <div className="border-b border-rim/50 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#3a4e6a]">
                {label}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edges */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        <defs>
          <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L0,6 L6,3 z" fill="rgba(79,121,231,0.6)" />
          </marker>
        </defs>
        {props.edges.map((edge) => {
          const from = props.nodes.find((n) => n.id === edge.fromId);
          const to = props.nodes.find((n) => n.id === edge.toId);
          if (!from || !to) return null;
          const x1 = displayLeft(from) + 172;
          const y1 = from.y + 36;
          const x2 = displayLeft(to);
          const y2 = to.y + 36;
          const cx = (x1 + x2) / 2;
          return (
            <path
              key={edge.id}
              d={`M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`}
              fill="none"
              stroke="rgba(79,121,231,0.5)"
              strokeWidth="1.5"
              markerEnd="url(#arrow)"
            />
          );
        })}
      </svg>

      {/* Nodes */}
      {props.nodes.map((node) => {
        const tone = props.linkSourceNodeId === node.id ? 'warning' : (node.accentTone ?? 'neutral');
        const colors = toneColors[tone];
        return (
          <div
            key={node.id}
            data-testid={`board-node-${node.id}`}
            className="absolute w-[172px] cursor-grab select-none rounded border shadow-lg active:cursor-grabbing"
            style={{ left: displayLeft(node), top: node.y, borderColor: colors.border, background: colors.bg, backdropFilter: 'blur(4px)' }}
            onPointerDown={(e) => {
              const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              setDragState({ nodeId: node.id, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top });
            }}
          >
            {/* Status bar */}
            <div className="h-[2px] w-full rounded-t" style={{ background: colors.dot }} />

            <div className="p-3">
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-1.5 w-1.5 rounded-full shrink-0" style={{ background: colors.dot }} />
                <span className="truncate text-[13px] font-semibold text-white">{node.title}</span>
              </div>
              <div className="mt-0.5 truncate pl-3 text-[11px] text-[#3a4e6a]">{node.subtitle ?? node.objectId}</div>
              <div className="mt-1 flex flex-wrap gap-1 pl-3">
                <span className="text-[9px] uppercase tracking-wide text-[#2e415a]">{node.objectType}</span>
                {node.status && <span className="text-[9px] uppercase tracking-wide text-[#2e415a]">· {node.status}</span>}
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-1 border-t border-rim/40 px-2 py-1.5">
              <button
                className="rounded px-1.5 py-0.5 text-[10px] text-[#3a4e6a] hover:bg-rim/60 hover:text-[#c8d6ef]"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); props.onChangeLinkSource(node.id); }}
                type="button"
              >Source</button>
              <button
                className="rounded px-1.5 py-0.5 text-[10px] text-[#3a4e6a] hover:bg-rim/60 hover:text-[#c8d6ef]"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (props.linkSourceNodeId && props.linkSourceNodeId !== node.id) {
                    const edgeId = `${props.linkSourceNodeId}->${node.id}`;
                    if (!props.edges.some((edge) => edge.id === edgeId)) {
                      props.onChangeEdges([...props.edges, { id: edgeId, fromId: props.linkSourceNodeId, toId: node.id }]);
                    }
                    props.onChangeLinkSource(null);
                  }
                }}
                type="button"
              >Target</button>
              <button
                className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-[#2e415a] hover:bg-[rgba(239,68,68,0.12)] hover:text-[#f87171]"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onChangeNodes(props.nodes.filter((n) => n.id !== node.id));
                  props.onChangeEdges(props.edges.filter((edge) => edge.fromId !== node.id && edge.toId !== node.id));
                  if (props.linkSourceNodeId === node.id) props.onChangeLinkSource(null);
                }}
                type="button"
                aria-label={`Knoten ${node.title} entfernen`}
              ><UiIcon name="close" size={16} /></button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
