import time, sys
sys.path.insert(0, ".")
from lib import unique_sorted
data = [i % 997 for i in range(60000)]
t = time.perf_counter()
for _ in range(3): unique_sorted(data)
print(f"{time.perf_counter() - t:.6f}")
