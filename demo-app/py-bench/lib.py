def unique_sorted(items):
    out = []
    for x in items:
        if x not in out:          # O(n^2): list membership
            out.append(x)
    return sorted(out)
