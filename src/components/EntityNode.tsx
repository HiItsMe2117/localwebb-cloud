import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { User, Building2, MapPin, Calendar, FileText, DollarSign, HelpCircle } from 'lucide-react';

// Modern Type Configuration
const TYPE_CONFIG: Record<string, { color: string; icon: typeof User }> = {
  PERSON:           { color: '#60a5fa', icon: User },
  ORGANIZATION:     { color: '#fbbf24', icon: Building2 },
  LOCATION:         { color: '#4ade80', icon: MapPin },
  EVENT:            { color: '#a78bfa', icon: Calendar },
  DOCUMENT:         { color: '#fb923c', icon: FileText },
  FINANCIAL_ENTITY: { color: '#f87171', icon: DollarSign },
};

const handleStyle = { background: '#3A3A3C', width: 8, height: 8, borderColor: '#1C1C1E', borderWidth: 2 };

type Tier = 'hub' | 'medium' | 'leaf';

function getTier(degree: number): Tier {
  if (degree >= 50) return 'hub';
  if (degree >= 5) return 'medium';
  return 'leaf';
}

function getScale(degree: number, tier: Tier): number {
  if (tier === 'leaf') return 0.7;
  // sqrt-based scaling for hub and medium: sqrt(degree) * 0.2 + 0.8
  return Math.sqrt(degree) * 0.2 + 0.8;
}

const handles = (
  <>
    <Handle type="target" position={Position.Top} id="t-top" style={handleStyle} />
    <Handle type="target" position={Position.Left} id="t-left" style={handleStyle} />
    <Handle type="source" position={Position.Bottom} id="s-bottom" style={handleStyle} />
    <Handle type="source" position={Position.Right} id="s-right" style={handleStyle} />
  </>
);

function EntityNode({ data, selected }: NodeProps) {
  const entityType = (data.entityType || 'PERSON').toUpperCase();
  const config = TYPE_CONFIG[entityType] || { color: '#9ca3af', icon: HelpCircle };
  const Icon = config.icon;
  const communityColor = data.communityColor || config.color;

  const degree: number = data.degree || 0;
  const tier = getTier(degree);
  const scale = getScale(degree, tier);

  // --- Leaf: compact pill ---
  if (tier === 'leaf') {
    const truncLabel = data.label?.length > 20 ? data.label.slice(0, 18) + '...' : data.label;
    return (
      <div
        className="bg-[#1C1C1E] rounded-lg flex items-center gap-2 px-2.5 py-1.5 transition-all duration-150"
        style={{
          border: `1.5px solid ${selected ? config.color : communityColor}40`,
          boxShadow: selected ? `0 0 12px ${config.color}30` : '0 1px 4px rgba(0,0,0,0.3)',
          maxWidth: 140,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
      >
        {handles}
        <div
          className="w-5 h-5 rounded flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${config.color}20` }}
        >
          <Icon size={11} style={{ color: config.color }} />
        </div>
        <p
          className="text-[11px] font-medium text-[rgba(235,235,245,0.7)] truncate"
          title={data.label}
        >
          {truncLabel}
        </p>
      </div>
    );
  }

  // --- Medium: card with icon + label, no description ---
  if (tier === 'medium') {
    return (
      <div
        className="bg-[#1C1C1E] shadow-lg rounded-xl overflow-hidden transition-all duration-150"
        style={{
          border: `2px solid ${selected ? config.color : communityColor}`,
          boxShadow: selected ? `0 0 20px ${config.color}30` : '0 2px 10px rgba(0,0,0,0.3)',
          minWidth: 180,
          maxWidth: 220,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
      >
        {handles}
        <div className="p-3" style={{ borderBottom: 'none' }}>
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: `${config.color}20` }}
            >
              <Icon size={16} style={{ color: config.color }} />
            </div>
            <div className="flex-1 overflow-hidden">
              <p
                className="text-sm font-semibold text-white truncate"
                title={data.label}
              >
                {data.label}
              </p>
              <span
                className="text-[10px] font-bold uppercase tracking-wider"
                style={{ color: config.color }}
              >
                {entityType}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- Hub: full card + description + connections badge + glow ---
  const description = data.description || '';
  const truncatedDesc = description.length > 70 ? description.slice(0, 67) + '...' : description;

  return (
    <div
      className="bg-[#1C1C1E] shadow-lg rounded-xl overflow-hidden transition-all duration-150"
      style={{
        border: `2px solid ${selected ? config.color : communityColor}`,
        boxShadow: selected
          ? `0 0 30px ${config.color}40`
          : `0 0 20px ${communityColor}15, 0 2px 10px rgba(0,0,0,0.3)`,
        minWidth: 240,
        maxWidth: 280,
        transform: `scale(${scale})`,
        transformOrigin: 'center center',
      }}
    >
      {handles}

      {/* Header */}
      <div className="p-3 border-b border-[rgba(84,84,88,0.65)]" style={{ borderBottomColor: `${communityColor}20` }}>
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: `${config.color}20` }}
          >
            <Icon size={18} style={{ color: config.color }} />
          </div>
          <div className="flex-1 overflow-hidden">
            <p
              className="text-[15px] font-bold text-white truncate"
              title={data.label}
            >
              {data.label}
            </p>
            <span
              className="text-[10px] font-bold uppercase tracking-wider"
              style={{ color: config.color }}
            >
              {entityType}
            </span>
          </div>
        </div>
      </div>

      {/* Body */}
      {truncatedDesc && (
        <div className="px-4 py-2.5 text-xs text-[rgba(235,235,245,0.6)] leading-relaxed">
          {truncatedDesc}
        </div>
      )}

      {/* Connections badge */}
      <div className="px-4 pb-3 pt-1">
        <span
          className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full"
          style={{ backgroundColor: `${config.color}15`, color: config.color }}
        >
          {degree} connections
        </span>
      </div>
    </div>
  );
}

export default memo(EntityNode);
