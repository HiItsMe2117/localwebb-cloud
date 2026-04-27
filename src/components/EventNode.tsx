import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { Scale, Gavel, DollarSign, Link, AlertTriangle, Landmark, Briefcase, Building2, Calendar, FileText, Globe } from 'lucide-react';

export const EVENT_CATEGORIES: Record<string, { label: string; color: string; icon: typeof Scale }> = {
  general:      { label: 'General',      color: '#8E8E93', icon: Calendar },
  property:     { label: 'Property',     color: '#34C759', icon: Building2 },
  'epstein-link': { label: 'Epstein Link', color: '#FFD60A', icon: Link },
  regulatory:   { label: 'Regulatory',   color: '#FF6B6B', icon: AlertTriangle },
  political:    { label: 'Political',    color: '#5E5CE6', icon: Landmark },
  corporate:    { label: 'Corporate',    color: '#5AC8FA', icon: Briefcase },
  financial:    { label: 'Financial',    color: '#FF9F0A', icon: DollarSign },
  legal:        { label: 'Legal',        color: '#AF52DE', icon: Gavel },
  crime:        { label: 'Crime',        color: '#FF453A', icon: AlertTriangle },
};

const handleStyle = { background: '#3A3A3C', width: 8, height: 8, borderColor: '#1C1C1E', borderWidth: 2, opacity: 0 };

export function formatEventDate(dateStr?: string | null): string {
  if (!dateStr) return 'No date';
  // Handle full ISO dates, partial dates (year only), etc.
  if (/^\d{4}$/.test(dateStr)) return dateStr;
  if (/^\d{4}-\d{2}$/.test(dateStr)) {
    const [y, m] = dateStr.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[parseInt(m, 10) - 1]} ${y}`;
  }
  try {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

function EventNode({ data, selected }: NodeProps) {
  const category = EVENT_CATEGORIES[data.category] || EVENT_CATEGORIES.general;
  const Icon = category.icon;
  const trackDots: { id: string; color: string; label: string }[] = data.trackDots || [];

  return (
    <div
      className="bg-[#1C1C1E] rounded-xl overflow-hidden transition-all duration-150"
      style={{
        width: 200,
        border: `1.5px solid ${selected ? category.color : category.color + '40'}`,
        boxShadow: selected
          ? `0 0 20px ${category.color}30`
          : '0 2px 8px rgba(0,0,0,0.3)',
      }}
    >
      <Handle type="target" position={Position.Top} id="t-top" style={handleStyle} />
      <Handle type="target" position={Position.Left} id="t-left" style={handleStyle} />
      <Handle type="source" position={Position.Bottom} id="s-bottom" style={handleStyle} />
      <Handle type="source" position={Position.Right} id="s-right" style={handleStyle} />

      {/* Color bar */}
      <div style={{ height: 4, backgroundColor: category.color }} />

      <div className="p-3">
        {/* Date + category */}
        <div className="flex items-center justify-between mb-1.5">
          <span
            className="text-[10px] font-mono font-semibold"
            style={{ color: category.color }}
          >
            {formatEventDate(data.event_date)}
          </span>
          <div
            className="w-5 h-5 rounded flex items-center justify-center"
            style={{ backgroundColor: `${category.color}20` }}
          >
            <Icon size={11} style={{ color: category.color }} />
          </div>
        </div>

        {/* Tags */}
        {data.tags && data.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {data.tags.map((tag: string) => (
              <span
                key={tag}
                className="text-[9px] font-bold px-1.5 py-0.5 rounded-md bg-[#2C2C2E] text-[rgba(235,235,245,0.4)] border border-[rgba(84,84,88,0.3)]"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Title */}
        <p
          className="text-[13px] font-bold text-white leading-tight mb-1"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
          title={data.title}
        >
          {data.title}
        </p>

        {/* Description */}
        {data.description && (
          <p
            className="text-[11px] text-[rgba(235,235,245,0.5)] leading-snug"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {data.description}
          </p>
        )}
      </div>

      {/* Footer: track dots + receipt indicator */}
      {(trackDots.length > 0 || data.sources?.length > 0) && (
        <div
          className="flex items-center gap-1 px-3 py-1.5 border-t"
          style={{ borderColor: `${category.color}20`, background: 'rgba(0,0,0,0.25)' }}
        >
          {trackDots.slice(0, 8).map(t => (
            <div
              key={t.id}
              className="w-2 h-2 rounded-full"
              style={{ background: t.color, boxShadow: `0 0 4px ${t.color}80` }}
              title={t.label}
            />
          ))}
          {trackDots.length > 8 && (
            <span className="text-[9px] font-mono text-[rgba(235,235,245,0.4)] ml-0.5">
              +{trackDots.length - 8}
            </span>
          )}
          {data.sources?.length > 0 && (() => {
            const fileCount = data.sources.filter((s: { filename?: string; uri?: string }) => s.filename && !s.uri).length;
            const webCount = data.sources.filter((s: { uri?: string }) => s.uri).length;
            return (
              <span
                className="ml-auto flex items-center gap-1 text-[9px] text-[rgba(235,235,245,0.35)]"
                title={`${fileCount} document source${fileCount !== 1 ? 's' : ''}, ${webCount} web source${webCount !== 1 ? 's' : ''}`}
              >
                {fileCount > 0 && (
                  <span className="flex items-center gap-0.5">
                    <FileText size={9} />
                    {fileCount}
                  </span>
                )}
                {webCount > 0 && (
                  <span className="flex items-center gap-0.5">
                    <Globe size={9} />
                    {webCount}
                  </span>
                )}
              </span>
            );
          })()}
        </div>
      )}
    </div>
  );
}

export default memo(EventNode);
