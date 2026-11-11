package network

import (
	"context"
	"time"

	"github.com/cenkalti/backoff/v5"
	"github.com/libp2p/go-libp2p/core/event"
)

func (d *DHT) startPublisher(ctx context.Context) {
	var sub event.Subscription
	if d.h != nil {
		if s, err := d.h.EventBus().Subscribe(new(event.EvtLocalAddressesUpdated)); err == nil {
			sub = s
		} else {
			d.logger.Warn("subscribe local address events failed", "error", err)
		}
	}
	d.wg.Add(1)
	go d.publishLoop(ctx, sub)
}

func (d *DHT) publishLoop(ctx context.Context, sub event.Subscription) {
	defer d.wg.Done()
	var events <-chan any
	if sub != nil {
		defer func() { _ = sub.Close() }()
		events = sub.Out()
	}
	initial := time.NewTimer(time.Second)
	defer initial.Stop()
	hourly := time.NewTicker(time.Hour)
	defer hourly.Stop()
	retry := time.NewTicker(30 * time.Second)
	defer retry.Stop()
	var debounce *time.Timer
	var debounceC <-chan time.Time
	defer func() {
		if debounce != nil {
			debounce.Stop()
		}
	}()
	publish := func() {
		if err := d.publishWithRetry(ctx); err != nil {
			d.setPublishError(err)
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-initial.C:
			publish()
		case <-hourly.C:
			publish()
		case <-retry.C:
			d.mu.Lock()
			never := d.lastPublish.IsZero()
			d.mu.Unlock()
			if never {
				publish()
			}
		case _, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			if debounce != nil {
				debounce.Stop()
			}
			debounce = time.NewTimer(10 * time.Second)
			debounceC = debounce.C
		case <-debounceC:
			publish()
			debounceC = nil
		}
	}
}

func (d *DHT) publishWithRetry(ctx context.Context) error {
	bo := backoff.NewExponentialBackOff()
	bo.InitialInterval = time.Second
	bo.MaxInterval = 30 * time.Second
	var last error
	for attempt := 0; attempt < 5; attempt++ {
		if err := d.publishOnce(ctx); err == nil {
			d.mu.Lock()
			d.lastPublish = time.Now().UTC()
			d.publishErr = ""
			d.mu.Unlock()
			return nil
		} else {
			last = err
			d.setPublishError(err)
		}
		wait := bo.NextBackOff()
		if wait <= 0 {
			break
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return last
}

func (d *DHT) setPublishError(err error) {
	if err == nil {
		return
	}
	d.mu.Lock()
	d.publishErr = err.Error()
	d.mu.Unlock()
}
