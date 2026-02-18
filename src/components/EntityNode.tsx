import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { User, Building2, MapPin, Calendar, FileText, DollarSign, HelpCircle } from 'lucide-react';

const TYPE_CONFIG: Record<string, { color: string; bg: string; border: string; icon: typeof User }> = {
  PERSON:           { color: '#93c5fd', bg: '#1e3a5f', border: '#3b82f6', icon: User },
  ORGANIZATION:     { color: '#fcd34d', bg: '#78350f', border: '#f59e0b', icon: Building2 },
  LOCATION:         { color: '#6ee7b7', bg: '#064e3b', border: '#10b981', icon: MapPin },
  EVENT:            { color: '#c4b5fd', bg: '#4c1d95', border: '#8b5cf6', icon: Calendar },
  DOCUMENT:         { color: '#fdba74', bg: '#7c2d12', border: '#f97316', icon: FileText },
  FINANCIAL_ENTITY: { color: '#fca5a5', bg: '#7f1d1d', border: '#ef4444', icon: DollarSign },
};

function EntityNode({ data }: NodeProps) {
  const entityType = (data.entityType || 'PERSON').toUpperCase();
  const config = TYPE_CONFIG[entityType] || { color: '#a1a1aa', bg: '#27272a', border: '#52525b', icon: HelpCircle };
  const Icon = config.icon;
  const communityColor = data.communityColor || config.border;

  const description = data.description || '';
  const truncated = description.length > 60 ? description.slice(0, 57) + '...' : description;

  return (
    <div
      style={{
        background: config.bg,
        border: `2px solid ${communityColor}`,
        borderRadius: 12,
        padding: '10px 14px',
        minWidth: 180,
        maxWidth: 220,
        cursor: 'pointer',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: config.border, width: 8, height: 8 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div
          style={{
            background: config.border + '33',
            borderRadius: 6,
            width: 24,
            height: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Icon size={14} color={config.color} />
        </div>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: config.color,
            lineHeight: 1.2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {data.label}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: truncated ? 4 : 0,
        }}
      >
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: config.color,
            background: config.border + '22',
            padding: '1px 6px',
            borderRadius: 4,
          }}
        >
          {entityType}
        </span>
      </div>

      {truncated && (
        <p
          style={{
            fontSize: 10,
            color: '#a1a1aa',
            margin: 0,
            lineHeight: 1.3,
          }}
        >
          {truncated}
        </p>
      )}

      <Handle type="source" position={Position.Bottom} style={{ background: config.border, width: 8, height: 8 }} />
    </div>
  );
}

export default memo(EntityNode);
