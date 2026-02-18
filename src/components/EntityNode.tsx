import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';

// Simplified type config for retro terminal style
const TYPE_CONFIG: Record<string, { color: string; prefix: string }> = {
  PERSON:           { color: '#4169E1', prefix: 'PER' }, // Royal Blue
  ORGANIZATION:     { color: '#f59e0b', prefix: 'ORG' }, // Amber
  LOCATION:         { color: '#10b981', prefix: 'LOC' }, // Emerald
  EVENT:            { color: '#8b5cf6', prefix: 'EVT' }, // Purple
  DOCUMENT:         { color: '#f97316', prefix: 'DOC' }, // Orange
  FINANCIAL_ENTITY: { color: '#ef4444', prefix: 'FIN' }, // Red
};

function EntityNode({ data }: NodeProps) {
  const entityType = (data.entityType || 'PERSON').toUpperCase();
  const config = TYPE_CONFIG[entityType] || { color: '#a4b9ef', prefix: '???' };
  const communityColor = data.communityColor || config.color;

  const description = data.description || '';
  const truncated = description.length > 50 ? description.slice(0, 47) + '...' : description;

  return (
    <div
      className="font-mono text-[10px] bg-[#050510]"
      style={{
        border: `1px solid ${communityColor}`,
        boxShadow: `0 0 5px ${communityColor}40`, // faint glow
        padding: '4px',
        minWidth: 160,
        maxWidth: 200,
        color: communityColor,
      }}
    >
      <Handle 
        type="target" 
        position={Position.Top} 
        style={{ background: communityColor, width: 6, height: 6, borderRadius: 0, border: 'none' }} 
      />

      <div className="flex items-center gap-2 mb-1 border-b border-dashed border-opacity-30 pb-1" style={{ borderColor: communityColor }}>
        <span className="font-bold bg-opacity-20 px-1" style={{ backgroundColor: communityColor, color: '#050510' }}>
          [{config.prefix}]
        </span>
        <span className="truncate font-bold uppercase tracking-tighter" title={data.label}>
          {data.label}
        </span>
      </div>

      {truncated && (
        <p className="opacity-80 leading-tight mb-1 text-[9px] text-[#a4b9ef] line-clamp-2">
          {truncated}
        </p>
      )}
      
      <div className="flex justify-between items-center opacity-50 text-[8px]">
         <span>ID:{data.id.slice(0,4)}</span>
         {data.community !== undefined && <span>CLUST:{data.community}</span>}
      </div>

      <Handle 
        type="source" 
        position={Position.Bottom} 
        style={{ background: communityColor, width: 6, height: 6, borderRadius: 0, border: 'none' }} 
      />
    </div>
  );
}

export default memo(EntityNode);
