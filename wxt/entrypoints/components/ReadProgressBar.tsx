import { toSearchProgress } from '@/entrypoints/utils/progress';

interface ReadProgressBarProps {
    completed: number;
    total: number;
}

// Reading submits one activity per step. The count is submissions confirmed by
// the API, not points credited — the same distinction the search bar makes.
function ReadProgressBar({ completed, total }: ReadProgressBarProps) {
    const { completed: done, total: goal, percent } = toSearchProgress(completed, total);
    return (
        <div
            className="search-progress"
            role="progressbar"
            aria-valuenow={done}
            aria-valuemin={0}
            aria-valuemax={goal}
            aria-label={`已提交 ${done} 次阅读，本轮目标 ${goal} 次，不代表获得积分`}
        >
            <div className="progress-summary">
                <span className="progress-count">
                    <span className="progress-number">{done}</span>
                    <span>/ {goal}</span>
                    <span>次阅读提交</span>
                </span>
            </div>
            <div className="progress-track" aria-hidden="true">
                <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
        </div>
    );
}

export default ReadProgressBar;
