python3 -m venv .venv


source .venv/bin/activate



python app/testing/gen_panorama_ip_named.py --out test_config.xml --size-mb 25 --base-network 10.0.0.0/8


python app/testing/gen_panorama_ip_named.py --out test_config.xml --size-mb 25 --base-network 10.0.0.0/8 --max-addrs 50000


DEBUG=1 node app/server.js


python app/testing/gen_panorama_massive_for_ip_finder.py \
  --out big_config.xml \
  --addr-count 200000 \
  --rules 100000 \
  --src-members 10 \
  --dst-members 10