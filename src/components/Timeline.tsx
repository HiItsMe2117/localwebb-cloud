import { useMemo, memo } from 'react';
import type { Edge } from 'reactflow';
import { Calendar } from 'lucide-react';

interface TimelineProps {
  allEdges: Edge[];
  currentYear: number;
  onYearChange: (year: number) => void;
  minYear?: number;
  maxYear?: number;
}

function Timeline({ allEdges, currentYear, onYearChange, minYear = 1980, maxYear = 2026 }: TimelineProps) {
  // Aggregate edges by year
  const yearData = useMemo(() => {
    const counts: Record<number, number> = {};
    
    // Initialize years
    for (let y = minYear; y <= maxYear; y++) {
      counts[y] = 0;
    }

    // Count edges with date_mentioned
    allEdges.forEach(edge => {
      const date = edge.data?.date_mentioned;
      if (date && typeof date === 'string') {
        const year = parseInt(date.slice(0, 4), 10);
        if (year >= minYear && year <= maxYear) {
          counts[year]++;
        }
      }
    });

    return counts;
  }, [allEdges, minYear, maxYear]);

  const maxCount = Math.max(...Object.values(yearData), 1);
  const years = Object.keys(yearData).map(Number).sort((a, b) => a - b);

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 w-[90%] max-w-2xl bg-[rgba(28,28,30,0.85)] backdrop-blur-xl border border-[rgba(84,84,88,0.5)] rounded-2xl p-4 shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-[#007AFF]" />
          <span className="text-[13px] font-bold text-white">Investigation Timeline</span>
        </div>
        <div className="bg-[#007AFF] px-2.5 py-0.5 rounded-full shadow-[0_0_10px_rgba(0,122,255,0.4)]">
          <span className="text-[11px] font-bold text-white tracking-tight">
            {currentYear >= maxYear ? 'ALL YEARS' : `THROUGH ${currentYear}`}
          </span>
        </div>
      </div>

      <div className="relative h-12 flex items-end gap-[2px] group pt-2">
        {years.map((year) => {
          const count = yearData[year];
          const height = (count / maxCount) * 100;
          const isSelected = year <= currentYear;
          const isTarget = year === currentYear;

          return (
            <div
              key={year}
              className="flex-1 relative cursor-pointer"
              style={{ height: '100%' }}
              onClick={() => onYearChange(year)}
              title={`${year}: ${count} connections`}
            >
              <div 
                className={`absolute bottom-0 w-full rounded-t-[1px] transition-all duration-300 ${
                  isTarget ? 'bg-[#007AFF] scale-x-125 z-10' : 
                  isSelected ? 'bg-[rgba(0,122,255,0.4)] hover:bg-[rgba(0,122,255,0.7)]' : 
                  'bg-[rgba(235,235,245,0.1)] hover:bg-[rgba(235,235,245,0.2)]'
                }`}
                style={{ height: `${Math.max(height, 5)}%` }}
              />
              
              {/* Year label for key milestones */}
              {(year % 5 === 0 || isTarget) && (
                <span className={`absolute -top-4 left-1/2 -translate-x-1/2 text-[8px] font-mono transition-opacity ${
                  isTarget ? 'text-[#007AFF] opacity-100 font-bold' : 'text-[rgba(235,235,245,0.3)] opacity-0 group-hover:opacity-100'
                }`}>
                  {year}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Main Slider Handle Overlay */}
      <input
        type="range"
        min={minYear}
        max={maxYear}
        value={currentYear}
        onChange={(e) => onYearChange(parseInt(e.target.value))}
        className="absolute bottom-0 left-0 w-full h-12 opacity-0 cursor-pointer z-20"
      />
      
      <div className="mt-2 flex justify-between text-[9px] font-mono text-[rgba(235,235,245,0.3)] uppercase tracking-widest px-1">
        <span>{minYear}</span>
        <span className="text-[rgba(235,235,245,0.15)]">DRAG TO FILTER BY TIME</span>
        <span>{maxYear}</span>
      </div>
    </div>
  );
}

export default memo(Timeline);
