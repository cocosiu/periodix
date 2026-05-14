class Periodix {
    /**
     * 待宰入口函数：输入合同信息，输出分片结果
     */
    static splitContractPeriods(contract) {
        this._validate(contract);

        const startDate = this._strToDate(contract.startDate);

        const endDate = this._strToDate(contract.endDate);
        // 定义拨片pivotDate，若无拨片，就默认为起租日
        const pivotDate = contract.pivotDate ? this._strToDate(contract.pivotDate) : startDate;

        const isNaturalMode = pivotDate.getDate() === 1;

        const freePeriods = this._getNormalizedFreePeriods(contract.freePeriods, startDate, endDate);

        const increaseEvents = this._getIncreaseEvents(contract, startDate, endDate);

        // 1. 生成关键时间断点 (含月度桶边界、免租边界、递增点)
        const cutDates = this._generateCutDates(startDate, endDate, pivotDate, isNaturalMode, freePeriods, increaseEvents);

        // 2. 生成片段并注入财务权重 (此时已区分 bucket)
        const rawSegments = this._generateRawSegments(cutDates, startDate, endDate, pivotDate, isNaturalMode, freePeriods, increaseEvents, contract);

        // 3. 合并逻辑 (同指纹片段聚合)
        const mergedSegments = this._mergeSegments(rawSegments);

        // 4. 最终渲染输出 (处理首期标记与金额补全)
        return this._renderResult(mergedSegments, contract, startDate, pivotDate);
    }

    //合并逻辑：将物理连续、同桶、同费率、同免租状态的片段进行收缩
    static _mergeSegments(rawSegments) {
        if (rawSegments.length === 0) return [];

        const merged = [];
        for (const seg of rawSegments) {
            const last = merged[merged.length - 1];
            const mEq = this._round(seg.meta.weight, 6);

            // 条件 1: 基础逻辑一致 (费率、免租状态、备注)
            const isSameLogic = last &&
                last.isFreeRent === seg.isFreeRent &&
                last.appliedIncreaseRate === seg.appliedIncreaseRate &&
                last.remark === seg.remark;

            // 条件 2: 身份准入 (非首期、非免租)；首期、免租期不参与合并
            const isIdentityEligible = last &&
                !last.isInitialPeriod && !seg.isInitialPeriod &&
                !last.isFreeRent && !seg.isFreeRent;

            // 条件 3: 完整性准入 (双方必须都是完整周期 mEq = 1)
            const lastMEq = last ? this._round(last.meta.weight, 6) : 0;
            // 判断是否为“任何意义上的完整周期”（即权重为 1 的整数倍，或是单次 1.0）；合并只允许发生在 1.0 + 1.0 的切片之间
            const isBothFull = last &&
                Math.abs(lastMEq % 1) < 1e-6 &&
                Math.abs(mEq - 1) < 1e-6;

            if (isSameLogic && isIdentityEligible && isBothFull) {
                // 满足合并条件
                last.endDate = seg.endDate;
                last.termDays += seg.termDays;
                // 月当量直接累加 (例如 1.0 + 1.0 = 2.0)
                last.meta.weight = this._round(last.meta.weight + seg.meta.weight, 6);
                // 这里不处理金额，金额由 _renderResult 统一根据最后的 weight 计算
            } else {
                // 不满足合并条件（残缺周期、首期、免租期、费率变动等）
                merged.push({ ...JSON.parse(JSON.stringify(seg)) });
            }
        }
        return merged;
    }

    // 渲染与金额计算逻辑
    static _renderResult(merged, contract, contractStart, pivotDate) {
        const area = contract.area || 0;
        const baseRentRate = contract.baseTotalRentRate || 0;
        const serviceRate = contract.serviceRate || 0;

        return merged.map(seg => {
            let rawWeight = seg.meta.weight;
            const segStart = this._strToDate(seg.startDate);
            const segEnd = this._strToDate(seg.endDate);

            // 判定是否为“非标/碎段”只要不是精确的 1.0, 2.0 等整月，就判定为非标
            const isNotFullMonth = Math.abs(rawWeight % 1) > 1e-6;

            // 只有非标段才需要重新核算自然月高精度权重
            if (isNotFullMonth) {
                rawWeight = this._computeNaturalMonthWeight(segStart, segEnd);
            }

            const isInitial = segStart >= contractStart && segEnd < pivotDate;
            const appliedRate = seg.appliedIncreaseRate;
            const rentMonthlyStandard = seg.isFreeRent ? 0 : this._round(baseRentRate * appliedRate, 2);
            const serviceMonthlyStandard = this._round(serviceRate * area, 2);

            let displayRent, displayService;

            //计算金额逻辑不变（确保钱是对的）
            if (!isNotFullMonth && rawWeight >= 1.0) {
                displayRent = rentMonthlyStandard;
                displayService = serviceMonthlyStandard;
            } else {
                displayRent = this._round(rentMonthlyStandard * rawWeight, 2);
                displayService = this._round(serviceMonthlyStandard * rawWeight, 2);
            }

            // 分化显示单位
            // 如果是碎段（isNotFullMonth），monthEquivalent 设为 null，强行计算实际天数 termDays
            // 如果是整段，termDays 设为 null，月当量显示整数
            const isFragment = isNotFullMonth || isInitial;

            return {
                ...seg,
                // 碎段不给月当量，整段给四舍五入后的整数月
                monthEquivalent: isFragment ? null : Math.round(rawWeight),

                // 碎段给物理天数，整段给 null
                termDays: isFragment ? seg.termDays : null,

                totalRent: displayRent,
                totalServiceFee: displayService,
                averageMonthlyRent: displayRent,
                averageMonthlyServiceFee: displayService,

                // 单价计算依然使用高精度 rawWeight 保持内部自洽
                rentUnitRate: (area > 0 && (isNotFullMonth ? rawWeight : 1) > 0)
                    ? this._round(displayRent / area / (isNotFullMonth ? rawWeight : 1), 4)
                    : 0,
                serviceUnitPrice: serviceRate,
                isInitialPeriod: !!isInitial
            };
        });
    }

    // 计算跨月片段的真实自然月比例
    static _computeNaturalMonthWeight(startDate, endDate) {
        let weight = 0;
        let curr = new Date(startDate);
        const end = new Date(endDate);

        while (curr <= end) {
            const y = curr.getFullYear(), m = curr.getMonth();
            const daysInMonth = new Date(y, m + 1, 0).getDate();
            const monthEnd = new Date(y, m, daysInMonth);
            const actualEnd = monthEnd < end ? monthEnd : end;

            const diff = this._getDaysDiff(curr, actualEnd) + 1;
            weight += diff / daysInMonth;

            curr = new Date(y, m + 1, 1);
        }
        return weight;
    }

    // 日期网格与切片核心逻辑
    static _generateCutDates(startDate, endDate, pivotDate, isNaturalMode, freePeriods, increaseEvents) {
        const cuts = new Set();
        cuts.add(this._formatDate(startDate));
        cuts.add(this._formatDate(this._addDays(endDate, 1)));

        // 正向铺设网格
        let curr = new Date(pivotDate);
        while (curr <= endDate) {
            if (curr >= startDate) cuts.add(this._formatDate(curr));
            curr = this._getNextStartPoint(curr, isNaturalMode);
        }

        // 反向补全 (针对 pivotDate > startDate 的首期情况)
        let p = new Date(pivotDate);
        let safety = 0;
        while (p > startDate && safety < 1200) {
            p = this._getPrevStartPoint(p, isNaturalMode);
            if (p >= startDate) cuts.add(this._formatDate(p));
            safety++;
        }

        // 业务切点：免租期、递增事件
        freePeriods.forEach(fp => {
            cuts.add(this._formatDate(fp.start));
            cuts.add(this._formatDate(this._addDays(fp.end, 1)));
        });
        increaseEvents.forEach(ev => cuts.add(this._formatDate(ev.date)));

        return Array.from(cuts)
            .map(s => this._strToDate(s))
            .filter(d => d >= startDate && d <= this._addDays(endDate, 1))
            .sort((a, b) => a - b);
    }

    static _generateRawSegments(cutDates, startDate, endDate, pivotDate, isNaturalMode, freePeriods, increaseEvents, contract) {
        const segments = [];
        for (let i = 0; i < cutDates.length - 1; i++) {
            const s = cutDates[i];
            const e = this._addDays(cutDates[i + 1], -1);
            if (s > endDate) break;

            const isFree = this._isInFreePeriod(s, freePeriods);
            const { rate: incRate, remark } = this._calcAppliedIncreaseRate(s, increaseEvents);
            const bucket = this._findBucket(s, pivotDate, isNaturalMode);
            const termDays = this._getDaysDiff(s, e) + 1;
            const bucketDays = this._getDaysDiff(bucket.pStart, bucket.pEnd) + 1;
            const weight = termDays / bucketDays;
            const isInitial = (s >= startDate && e < pivotDate);
            segments.push({
                startDate: this._formatDate(s),
                endDate: this._formatDate(e),
                termDays: termDays,
                isFreeRent: isFree,
                appliedIncreaseRate: incRate,
                remark: remark,
                isInitialPeriod: isInitial,
                serviceRate: contract.serviceRate,
                meta: {
                    bucketStart: this._formatDate(bucket.pStart),
                    bucketEnd: this._formatDate(bucket.pEnd),
                    weight: weight
                },
                // 指纹 fingerprint: `${isFree}_${incRate.toFixed(4)}_${this._formatDate(bucket.pStart)}`
                fingerprint: isInitial
                    ? `initial_${isFree}_${incRate.toFixed(4)}`
                    : `normal_${isFree}_${incRate.toFixed(4)}_${this._formatDate(bucket.pStart)}`
            });
        }
        return segments;
    }

    static _findBucket(date, pivotDate, isNaturalMode) {
        let currStart = new Date(pivotDate);
        if (date < pivotDate) {
            while (currStart > date) {
                let prev = this._getPrevStartPoint(currStart, isNaturalMode);
                if (prev <= date) { currStart = prev; break; }
                currStart = prev;
            }
        } else {
            while (true) {
                let next = this._getNextStartPoint(currStart, isNaturalMode);
                if (next > date) break;
                currStart = next;
            }
        }
        return {
            pStart: currStart,
            pEnd: this._addDays(this._getNextStartPoint(currStart, isNaturalMode), -1)
        };
    }

    static _getNextStartPoint(s, isNaturalMode) {
        const d = new Date(s);
        if (isNaturalMode) {
            d.setMonth(d.getMonth() + 1);
            return d;
        } else {
            const refMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
            const quota = new Date(refMonth.getFullYear(), refMonth.getMonth() + 1, 0).getDate();
            d.setDate(d.getDate() + quota);
            return d;
        }
    }

    static _getPrevStartPoint(s, isNaturalMode) {
        const d = new Date(s);
        if (isNaturalMode) {
            d.setMonth(d.getMonth() - 1);
            return d;
        } else {
            let candidate = new Date(s);
            candidate.setDate(candidate.getDate() - 31);
            let check = this._getNextStartPoint(candidate, false);
            let diff = (s.getTime() - check.getTime()) / 86400000;
            candidate.setDate(candidate.getDate() + Math.round(diff));
            return candidate;
        }
    }

    static _getIncreaseEvents(contract, startDate, endDate) {
        const events = [];
        (contract.increaseRules || []).forEach(rule => {
            if (rule.type === 'POINT') {
                const d = this._strToDate(rule.effectiveDate);
                if (d >= startDate && d <= endDate) events.push({ date: d, rate: rule.rate, type: 'POINT' });
            } else if (rule.type === 'ANNIVERSARY') {
                let d = this._strToDate(rule.anchorDate);
                while (true) {
                    const eff = this._addDays(d, 1);
                    if (eff > endDate) break;
                    if (eff >= startDate) events.push({ date: eff, rate: rule.rate, type: 'ANNIVERSARY' });
                    d.setFullYear(d.getFullYear() + 1);
                }
            }
        });
        return events.sort((a, b) => a.date - b.date);
    }

    static _calcAppliedIncreaseRate(date, events) {
        let rate = 1.0;
        let remark = '';
        events.forEach(ev => {
            if (ev.date <= date) {
                rate = this._round(rate * (1 + ev.rate), 8);
                remark = `${ev.type === 'ANNIVERSARY' ? '周年' : '打点'}递增_${this._formatDate(ev.date)}`;
            }
        });
        return { rate: this._round(rate, 4), remark };
    }

    static _getNormalizedFreePeriods(fps, startDate, endDate) {
        return (fps || []).map(fp => ({ start: this._strToDate(fp.startDate), end: this._strToDate(fp.endDate) }))
            .filter(fp => fp.start <= endDate && fp.end >= startDate)
            .map(fp => ({ start: fp.start < startDate ? startDate : fp.start, end: fp.end > endDate ? endDate : fp.end }))
            .sort((a, b) => a.start - b.start);
    }

    static _isInFreePeriod(date, fps) {
        return fps.some(fp => date >= fp.start && date <= fp.end);
    }

    static _strToDate(s) {
        const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d);
    }
    static _formatDate(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    static _addDays(d, n) {
        const res = new Date(d); res.setDate(res.getDate() + n); return res;
    }

    static _getDaysDiff(a, b) {
        return Math.round((b - a) / 86400000);
    }

    static _round(n, d) {
        return Number(Math.round(n + 'e' + d) + 'e-' + d);
    }

    static _validate(c) {
        if (!c.startDate || !c.endDate) throw new Error('日期缺失');
    }
}

module.exports = Periodix;