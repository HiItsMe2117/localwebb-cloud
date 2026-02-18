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

function EntityNode({ data, selected }: NodeProps) {
  const entityType = (data.entityType || 'PERSON').toUpperCase();
  const config = TYPE_CONFIG[entityType] || { color: '#9ca3af', icon: HelpCircle };
  const Icon = config.icon;
  const communityColor = data.communityColor || config.color;

  const description = data.description || '';
  const truncatedDesc = description.length > 70 ? description.slice(0, 67) + '...' : description;

  return (
    <div
      className="bg-[#1C1C1E] shadow-lg rounded-xl overflow-hidden transition-all duration-150"
      style={{
        border: `2px solid ${selected ? config.color : communityColor}`,
        boxShadow: selected ? `0 0 20px ${config.color}30` : `0 2px 10px rgba(0,0,0,0.3)`,
        minWidth: 220,
        maxWidth: 240,
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: '#3A3A3C', width: 10, height: 10, borderColor: '#1C1C1E', borderWidth: 2 }}
      />

      {/* Header */}
      <div className="p-3 border-b border-[rgba(84,84,88,0.65)]" style={{ borderBottomColor: `${communityColor}20`}}>
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

      {/* Body */}
      {truncatedDesc && (
        <div className="px-4 py-3 text-xs text-[rgba(235,235,245,0.6)] leading-relaxed">
          {truncatedDesc}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: '#3A3A3C', width: 10, height: 10, borderColor: '#1C1C1E', borderWidth: 2 }}
      />
    </div>
  );
}

export default memo(EntityNode);
